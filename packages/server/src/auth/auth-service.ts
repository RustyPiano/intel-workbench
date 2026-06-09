import { randomBytes } from "node:crypto";

import type { AuditService } from "../audit/audit-service.js";
import { AppError } from "../domain/identity.js";
import type { Identity } from "../domain/types.js";
import { hashPassword, UserStore, verifyPassword } from "./user-store.js";

/**
 * 固定假哈希：用户不存在/停用时仍跑一次等价 scrypt 校验，抹平「有此用户」与
 * 「无此用户」之间的登录计时差，消除用户名枚举侧信道。
 */
const DUMMY_HASH = hashPassword("intel-workbench-timing-equalizer");

/**
 * 本地登录与会话（产品 spec §8.1）。口令经 UserStore 校验，成功后发放内存态
 * 会话令牌（进程重启即失效——单机离线应用可接受，也避免令牌落盘）。失败计数
 * 与临时锁定按用户名维护；登录/登出均入审计。
 */

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

interface Session {
  identity: Identity;
  expiresAt: number;
}

interface Lock {
  fails: number;
  /** 锁定截止时间戳；0 表示未锁定，仅累计失败次数。 */
  until: number;
}

export class AuthService {
  private readonly sessions = new Map<string, Session>();
  private readonly locks = new Map<string, Lock>();

  constructor(
    private readonly users: UserStore,
    private readonly audit: AuditService,
    private readonly now: () => number = Date.now,
  ) {}

  async login(username: string, password: string): Promise<{ token: string; identity: Identity }> {
    const id = (username ?? "").trim();
    const t = this.now();
    const lock = this.locks.get(id);
    if (lock && lock.until > t) {
      await this.deny(id, "locked");
      throw new AppError(429, `尝试过于频繁，请 ${Math.ceil((lock.until - t) / 1000)} 秒后再试`);
    }

    const user = await this.users.findById(id);
    // 恒定走一次 scrypt：缺失/停用用户用假哈希，使两条路径耗时一致。
    const passwordOk = verifyPassword(password ?? "", user?.enabled ? user.pwd_hash : DUMMY_HASH);
    const ok = Boolean(user) && user!.enabled && passwordOk;
    if (!ok) {
      const fails = (lock?.fails ?? 0) + 1;
      const until = fails >= MAX_FAILS ? t + LOCKOUT_MS : 0;
      this.locks.set(id, { fails: until ? 0 : fails, until });
      await this.deny(id, !user ? "no_user" : !user.enabled ? "disabled" : "bad_password");
      throw new AppError(401, "用户名或口令错误");
    }

    this.locks.delete(id);
    const token = randomBytes(32).toString("hex");
    const identity: Identity = { id: user!.id, name: user!.name, role: user!.role, clearance: user!.clearance };
    this.sessions.set(token, { identity, expiresAt: t + SESSION_TTL_MS });
    await this.audit.append({ user: identity.id, action: "auth.login", object: `user:${identity.id}`, result: "ok" });
    return { token, identity };
  }

  /** 解析令牌为身份；过期或未知返回 null。 */
  resolve(token: string | undefined): Identity | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expiresAt <= this.now()) {
      this.sessions.delete(token);
      return null;
    }
    return s.identity;
  }

  async logout(token: string | undefined, actor: Identity): Promise<void> {
    if (token) this.sessions.delete(token);
    await this.audit.append({ user: actor.id, action: "auth.logout", object: `user:${actor.id}`, result: "ok" });
  }

  private async deny(id: string, reason: string): Promise<void> {
    await this.audit.append({ user: id || "?", action: "auth.login", object: `user:${id || "?"}`, result: "deny", detail: { reason } });
  }
}
