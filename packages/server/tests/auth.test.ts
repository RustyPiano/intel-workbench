import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { AuthService } from "../src/auth/auth-service.js";
import { UserStore, verifyPassword } from "../src/auth/user-store.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";

describe("AuthService 登录与会话（产品 spec §8.1）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let users: UserStore;
  let clock: number;
  let savedDemo: string | undefined;

  function service(): AuthService {
    return new AuthService(users, audit, () => clock);
  }

  beforeEach(async () => {
    savedDemo = process.env.MINI_AGENT_DEMO;
    delete process.env.MINI_AGENT_DEMO;
    root = await mkdtemp(path.join(tmpdir(), "iw-auth-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    users = new UserStore(paths);
    clock = 1_000_000;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (savedDemo === undefined) delete process.env.MINI_AGENT_DEMO;
    else process.env.MINI_AGENT_DEMO = savedDemo;
  });

  async function readInitialPassword(): Promise<string> {
    const raw = await readFile(path.join(paths.configDir, "initial-admin-password.json"), "utf8");
    return (JSON.parse(raw) as { password: string }).password;
  }

  it("首启生成一次性随机管理员口令；默认不创建演示账号", async () => {
    const auth = service();
    const usersOnFirstBoot = await users.list();
    expect(usersOnFirstBoot.map((u) => u.id)).toEqual(["admin"]);
    expect(usersOnFirstBoot[0]).toMatchObject({ role: "admin", clearance: "topsecret", mustChangePassword: true });

    const initialPassword = await readInitialPassword();
    expect(initialPassword).toHaveLength(32);
    expect(["admin123", "operator123", "security123"]).not.toContain(initialPassword);
    await expect(auth.login("operator", "operator123")).rejects.toMatchObject({ status: 401 });

    const { token, identity } = await auth.login("admin", initialPassword);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(identity).toMatchObject({ id: "admin", role: "admin", clearance: "topsecret", mustChangePassword: true });
    expect(auth.resolve(token)).toMatchObject({ id: "admin", mustChangePassword: true });
    expect((await audit.readAll()).some((e) => e.action === "auth.login" && e.result === "ok")).toBe(true);
  });

  it("MINI_AGENT_DEMO=1 时才创建演示账号", async () => {
    process.env.MINI_AGENT_DEMO = "1";
    const auth = service();
    const listed = await users.list();
    expect(listed.map((u) => u.id).sort()).toEqual(["admin", "operator", "security"]);
    expect((await auth.login("operator", "operator123")).identity).toMatchObject({ id: "operator", role: "operator" });
  });

  it("口令绝不明文落盘（scrypt 哈希）", async () => {
    await users.list(); // 触发 users.json 预置
    const initialPassword = await readInitialPassword();
    const raw = await readFile(paths.usersFile, "utf8");
    expect(raw).not.toContain(initialPassword);
    expect(raw).toContain("scrypt:");
  });

  it("错误口令 → 401，审计 deny", async () => {
    const auth = service();
    await expect(auth.login("admin", "nope")).rejects.toMatchObject({ status: 401 });
    expect((await audit.readAll()).some((e) => e.action === "auth.login" && e.result === "deny")).toBe(true);
  });

  it("连续 5 次失败 → 锁定（429）；解锁窗口后恢复", async () => {
    const auth = service();
    const initialPassword = await readInitialPassword().catch(async () => {
      await users.list();
      return readInitialPassword();
    });
    for (let i = 0; i < 5; i++) {
      await expect(auth.login("admin", "bad")).rejects.toMatchObject({ status: 401 });
    }
    // 第 6 次即便口令正确也被锁定
    await expect(auth.login("admin", initialPassword)).rejects.toMatchObject({ status: 429 });
    clock += 5 * 60 * 1000 + 1; // 越过锁定窗口
    const ok = await auth.login("admin", initialPassword);
    expect(ok.token).toBeTruthy();
  });

  it("未知令牌 / 过期令牌 → resolve 返回 null", async () => {
    const auth = service();
    expect(auth.resolve("deadbeef")).toBeNull();
    expect(auth.resolve(undefined)).toBeNull();
    await users.list();
    const { token } = await auth.login("admin", await readInitialPassword());
    clock += 12 * 60 * 60 * 1000 + 1; // 越过会话 TTL
    expect(auth.resolve(token)).toBeNull();
  });

  it("logout 使令牌失效", async () => {
    const auth = service();
    await users.list();
    const { token, identity } = await auth.login("admin", await readInitialPassword());
    await auth.logout(token, identity);
    expect(auth.resolve(token)).toBeNull();
    expect((await audit.readAll()).some((e) => e.action === "auth.logout")).toBe(true);
  });

  it("首次登录后必须改成长口令，且不能复用首启口令", async () => {
    const auth = service();
    await users.list();
    const initialPassword = await readInitialPassword();
    const { token } = await auth.login("admin", initialPassword);

    await expect(auth.changePassword(token, initialPassword, "too-short")).rejects.toMatchObject({ status: 400 });
    await expect(auth.changePassword(token, initialPassword, initialPassword)).rejects.toMatchObject({ status: 400 });

    await auth.changePassword(token, initialPassword, "admin-new-password");
    const changed = await auth.login("admin", "admin-new-password");
    expect(changed.identity.mustChangePassword).toBe(false);
  });

  it("首次管理员改密后删除首启明文口令文件", async () => {
    const auth = service();
    await users.list();
    const initialPassword = await readInitialPassword();
    const { token } = await auth.login("admin", initialPassword);

    await auth.changePassword(token, initialPassword, "admin-new-password");

    await expect(readFile(path.join(paths.configDir, "initial-admin-password.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(users.setPassword("admin", initialPassword)).resolves.toBeUndefined();
  });

  it("并发首启只生成一个可登录管理员口令", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await Promise.all(Array.from({ length: 16 }, () => users.list()));
    } finally {
      console.log = originalLog;
    }

    const initialPassword = await readInitialPassword();
    const admin = await users.findById("admin");
    const printed = logs
      .filter((line) => line.startsWith("Intel Workbench initial admin password: "))
      .map((line) => line.slice("Intel Workbench initial admin password: ".length));

    expect(printed).toEqual([initialPassword]);
    expect(admin).toBeTruthy();
    expect(verifyPassword(initialPassword, admin!.pwd_hash)).toBe(true);
    expect((await service().login("admin", initialPassword)).identity).toMatchObject({ id: "admin", mustChangePassword: true });
  });
});
