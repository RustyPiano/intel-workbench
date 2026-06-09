import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { AuthService } from "../src/auth/auth-service.js";
import { UserStore } from "../src/auth/user-store.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";

describe("AuthService 登录与会话（产品 spec §8.1）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let users: UserStore;
  let clock: number;

  function service(): AuthService {
    return new AuthService(users, audit, () => clock);
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-auth-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    users = new UserStore(paths);
    clock = 1_000_000;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("正确口令 → 发令牌 + 身份；resolve 可还原；审计 auth.login=ok", async () => {
    const auth = service();
    const { token, identity } = await auth.login("operator", "operator123");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(identity).toMatchObject({ id: "operator", role: "operator", clearance: "confidential" });
    expect(auth.resolve(token)).toMatchObject({ id: "operator" });
    expect((await audit.readAll()).some((e) => e.action === "auth.login" && e.result === "ok")).toBe(true);
  });

  it("口令绝不明文落盘（scrypt 哈希）", async () => {
    await service().login("operator", "operator123"); // 触发 users.json 预置
    const raw = await readFile(paths.usersFile, "utf8");
    expect(raw).not.toContain("operator123");
    expect(raw).toContain("scrypt:");
  });

  it("错误口令 → 401，审计 deny", async () => {
    const auth = service();
    await expect(auth.login("operator", "nope")).rejects.toMatchObject({ status: 401 });
    expect((await audit.readAll()).some((e) => e.action === "auth.login" && e.result === "deny")).toBe(true);
  });

  it("连续 5 次失败 → 锁定（429）；解锁窗口后恢复", async () => {
    const auth = service();
    for (let i = 0; i < 5; i++) {
      await expect(auth.login("operator", "bad")).rejects.toMatchObject({ status: 401 });
    }
    // 第 6 次即便口令正确也被锁定
    await expect(auth.login("operator", "operator123")).rejects.toMatchObject({ status: 429 });
    clock += 5 * 60 * 1000 + 1; // 越过锁定窗口
    const ok = await auth.login("operator", "operator123");
    expect(ok.token).toBeTruthy();
  });

  it("未知令牌 / 过期令牌 → resolve 返回 null", async () => {
    const auth = service();
    expect(auth.resolve("deadbeef")).toBeNull();
    expect(auth.resolve(undefined)).toBeNull();
    const { token } = await auth.login("admin", "admin123");
    clock += 12 * 60 * 60 * 1000 + 1; // 越过会话 TTL
    expect(auth.resolve(token)).toBeNull();
  });

  it("logout 使令牌失效", async () => {
    const auth = service();
    const { token, identity } = await auth.login("security", "security123");
    await auth.logout(token, identity);
    expect(auth.resolve(token)).toBeNull();
    expect((await audit.readAll()).some((e) => e.action === "auth.logout")).toBe(true);
  });
});
