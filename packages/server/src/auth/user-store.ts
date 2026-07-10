import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { FileMutationQueue } from "mini-agent";

import type { DataPaths } from "../data/paths.js";
import { AppError } from "../domain/identity.js";
import { CLEARANCES, ROLES, type Clearance, type Role } from "../domain/types.js";
import { writeFileAtomic } from "../util/atomic.js";

/**
 * 本地用户存储（工程方案 §4.2，`config/users.json`）。口令以 scrypt 加盐哈希
 * 落盘；首启生成一次性管理员口令，演示账号仅在显式开关下创建。
 */

export interface StoredUser {
  id: string;
  name: string;
  role: Role;
  clearance: Clearance;
  enabled: boolean;
  must_change_password?: boolean;
  /** `scrypt:<saltHex>:<dkHex>`，仅服务端持有，不回前端。 */
  pwd_hash: string;
}

export interface PublicUser {
  id: string;
  name: string;
  role: Role;
  clearance: Clearance;
  enabled: boolean;
  mustChangePassword: boolean;
}

const SCRYPT_KEYLEN = 64;
const MIN_PASSWORD_LENGTH = 12;
const INITIAL_ADMIN_PASSWORD_FILE = "initial-admin-password.json";

/** 口令哈希：随机盐 + scrypt，自描述格式便于校验。 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const dk = scryptSync(plain, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString("hex")}:${dk.toString("hex")}`;
}

/** 恒定时间比对，避免计时侧信道。 */
export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (expected.length === 0) return false;
  let dk: Buffer;
  try {
    dk = scryptSync(plain, salt, expected.length);
  } catch {
    return false;
  }
  return timingSafeEqual(expected, dk);
}

/** 演示账号仅在 MINI_AGENT_DEMO=1 时创建。 */
const SEED_DEFAULTS: { user: PublicUser; password: string }[] = [
  { user: { id: "admin", name: "管理员", role: "admin", clearance: "topsecret", enabled: true, mustChangePassword: false }, password: "admin12345678" },
  { user: { id: "operator", name: "作业员", role: "operator", clearance: "confidential", enabled: true, mustChangePassword: false }, password: "operator123456" },
  { user: { id: "security", name: "保密员", role: "security", clearance: "topsecret", enabled: true, mustChangePassword: false }, password: "security123456" },
];

/** 去除口令哈希，得到可回前端的公开用户。 */
function strip(user: StoredUser): PublicUser {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    clearance: user.clearance,
    enabled: user.enabled,
    mustChangePassword: user.must_change_password === true,
  };
}

export class UserStore {
  private seedPromise: Promise<StoredUser[]> | null = null;
  private readonly queue = new FileMutationQueue();
  private readonly securityChangeListeners = new Set<(id: string) => void>();

  constructor(private readonly paths: DataPaths) {}

  async list(): Promise<PublicUser[]> {
    return (await this.read()).map(strip);
  }

  async findById(id: string): Promise<StoredUser | undefined> {
    return (await this.read()).find((u) => u.id === id);
  }

  /** 角色/密级/启停/口令变更后通知会话层撤销旧令牌。 */
  onSecurityChange(listener: (id: string) => void): () => void {
    this.securityChangeListeners.add(listener);
    return () => this.securityChangeListeners.delete(listener);
  }

  async ensureDemoUsers(): Promise<void> {
    const changed = await this.queue.runExclusive(this.paths.usersFile, async () => {
      const users = await this.read();
      for (const { user, password } of SEED_DEFAULTS) {
        const existing = users.find((u) => u.id === user.id);
        if (!existing) {
          users.push({
            id: user.id,
            name: user.name,
            role: user.role,
            clearance: user.clearance,
            enabled: true,
            must_change_password: false,
            pwd_hash: hashPassword(password),
          });
          continue;
        }
        existing.name = user.name;
        existing.role = user.role;
        existing.clearance = user.clearance;
        existing.enabled = true;
        existing.must_change_password = false;
        if (!verifyPassword(password, existing.pwd_hash)) existing.pwd_hash = hashPassword(password);
      }
      await this.write(users);
      return SEED_DEFAULTS.map(({ user }) => user.id);
    });
    changed.forEach((id) => this.notifySecurityChange(id));
  }

  async create(input: { id: string; name: string; role: Role; clearance: Clearance; password: string }): Promise<PublicUser> {
    const id = input.id.trim();
    if (!id) throw new AppError(400, "账号 id 不能为空");
    if (!ROLES.includes(input.role)) throw new AppError(400, "非法角色");
    if (!CLEARANCES.includes(input.clearance)) throw new AppError(400, "非法密级");
    await this.assertAcceptablePassword(input.password);
    return this.queue.runExclusive(this.paths.usersFile, async () => {
      const users = await this.read();
      if (users.some((u) => u.id === id)) throw new AppError(409, "账号已存在");
      const user: StoredUser = {
        id,
        name: input.name.trim() || id,
        role: input.role,
        clearance: input.clearance,
        enabled: true,
        must_change_password: false,
        pwd_hash: hashPassword(input.password),
      };
      users.push(user);
      await this.write(users);
      return strip(user);
    });
  }

  async update(id: string, patch: { name?: string; role?: Role; clearance?: Clearance; enabled?: boolean }): Promise<PublicUser> {
    let securityChanged = false;
    const result = await this.queue.runExclusive(this.paths.usersFile, async () => {
      const users = await this.read();
      const user = users.find((u) => u.id === id);
      if (!user) throw new AppError(404, "用户不存在");
      if (patch.role !== undefined) {
        if (!ROLES.includes(patch.role)) throw new AppError(400, "非法角色");
        securityChanged ||= patch.role !== user.role;
        user.role = patch.role;
      }
      if (patch.clearance !== undefined) {
        if (!CLEARANCES.includes(patch.clearance)) throw new AppError(400, "非法密级");
        securityChanged ||= patch.clearance !== user.clearance;
        user.clearance = patch.clearance;
      }
      if (patch.name !== undefined) user.name = patch.name.trim() || user.id;
      if (patch.enabled !== undefined) {
        securityChanged ||= patch.enabled !== user.enabled;
        user.enabled = patch.enabled;
      }
      await this.write(users);
      return strip(user);
    });
    if (securityChanged) this.notifySecurityChange(id);
    return result;
  }

  async setPassword(id: string, password: string): Promise<void> {
    await this.assertAcceptablePassword(password);
    await this.queue.runExclusive(this.paths.usersFile, async () => {
      const users = await this.read();
      const user = users.find((u) => u.id === id);
      if (!user) throw new AppError(404, "用户不存在");
      const removeInitialPassword = id === "admin" && user.must_change_password === true;
      user.pwd_hash = hashPassword(password);
      user.must_change_password = false;
      await this.write(users);
      if (removeInitialPassword) await this.removeInitialAdminPassword();
    });
    this.notifySecurityChange(id);
  }

  private async read(): Promise<StoredUser[]> {
    try {
      return JSON.parse(await readFile(this.paths.usersFile, "utf8")) as StoredUser[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return this.seedUsers();
      }
      throw e;
    }
  }

  private seedUsers(): Promise<StoredUser[]> {
    if (!this.seedPromise) {
      this.seedPromise = this.createSeededUsers().finally(() => {
        this.seedPromise = null;
      });
    }
    return this.seedPromise;
  }

  private async createSeededUsers(): Promise<StoredUser[]> {
    const seeded = process.env.MINI_AGENT_DEMO === "1"
      ? SEED_DEFAULTS.map(({ user, password }) => ({
        id: user.id,
        name: user.name,
        role: user.role,
        clearance: user.clearance,
        enabled: user.enabled,
        must_change_password: false,
        pwd_hash: hashPassword(password),
      }))
      : [await this.createInitialAdmin()];
    await this.write(seeded);
    return seeded;
  }

  private async createInitialAdmin(): Promise<StoredUser> {
    let password = await this.readInitialAdminPassword();
    if (!password) {
      password = randomBytes(24).toString("base64url");
      await mkdir(this.paths.configDir, { recursive: true });
      try {
        await writeFile(
          this.initialAdminPasswordFile(),
          `${JSON.stringify({ username: "admin", password, createdAt: new Date().toISOString() }, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        );
        console.log(`Intel Workbench initial admin password: ${password}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const existing = await this.readInitialAdminPassword();
        if (!existing) throw e;
        password = existing;
      }
    }
    return {
      id: "admin",
      name: "管理员",
      role: "admin",
      clearance: "topsecret",
      enabled: true,
      must_change_password: true,
      pwd_hash: hashPassword(password),
    };
  }

  private async assertAcceptablePassword(password: string): Promise<void> {
    if (!password) throw new AppError(400, "口令不能为空");
    if (password.length < MIN_PASSWORD_LENGTH) throw new AppError(400, "口令长度至少 12 位");
    if (password === await this.readInitialAdminPassword()) throw new AppError(400, "新口令不能复用首启管理员口令");
  }

  private async readInitialAdminPassword(): Promise<string | null> {
    try {
      const raw = JSON.parse(await readFile(this.initialAdminPasswordFile(), "utf8")) as { password?: unknown };
      return typeof raw.password === "string" ? raw.password : null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  private initialAdminPasswordFile(): string {
    return path.join(this.paths.configDir, INITIAL_ADMIN_PASSWORD_FILE);
  }

  private async removeInitialAdminPassword(): Promise<void> {
    try {
      await unlink(this.initialAdminPasswordFile());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  private async write(users: StoredUser[]): Promise<void> {
    await mkdir(path.dirname(this.paths.usersFile), { recursive: true });
    await writeFileAtomic(this.paths.usersFile, `${JSON.stringify(users, null, 2)}\n`);
  }

  private notifySecurityChange(id: string): void {
    for (const listener of this.securityChangeListeners) listener(id);
  }
}
