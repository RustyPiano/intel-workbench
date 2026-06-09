import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdminService } from "../src/admin/admin-service.js";
import { AuditService } from "../src/audit/audit-service.js";
import { AuthService } from "../src/auth/auth-service.js";
import { UserStore } from "../src/auth/user-store.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Identity } from "../src/domain/types.js";
import type { ModelConfig } from "../src/model/model-config.js";

const ADMIN: Identity = { id: "admin", name: "admin", role: "admin", clearance: "topsecret" };
const UNCONFIGURED: ModelConfig = { configured: false, provider: "openai-compatible", model: "", baseURL: "", apiKey: "", host: "" };
const CONFIGURED: ModelConfig = {
  configured: true,
  provider: "openai-compatible",
  model: "deepseek-v4-flash",
  baseURL: "https://api.deepseek.com",
  apiKey: "secret",
  host: "api.deepseek.com",
};

describe("AdminService 管理后台（M5）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-admin-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("listSkills 扫描 .agents/skills，含 intel-bulletin，默认启用", async () => {
    const admin = new AdminService(paths, audit, UNCONFIGURED, [], new UserStore(paths));
    const skills = await admin.listSkills();
    const bulletin = skills.find((s) => s.name === "intel-bulletin");
    expect(bulletin).toBeTruthy();
    expect(bulletin?.enabled).toBe(true);
    expect(bulletin?.healthy).toBe(true);
  });

  it("setSkillEnabled 持久化并入审计", async () => {
    const admin = new AdminService(paths, audit, UNCONFIGURED, [], new UserStore(paths));
    await admin.setSkillEnabled(ADMIN, "intel-bulletin", false);
    const skills = await admin.listSkills();
    expect(skills.find((s) => s.name === "intel-bulletin")?.enabled).toBe(false);
    const cfg = JSON.parse(await readFile(path.join(paths.configDir, "skills.json"), "utf8"));
    expect(cfg["intel-bulletin"]).toBe(false);
    expect((await audit.readAll()).some((e) => e.action === "config.skill")).toBe(true);
  });

  it("modelDoctor 脱敏：报告配置与白名单，不含 apiKey", () => {
    const admin = new AdminService(paths, audit, CONFIGURED, ["api.deepseek.com"], new UserStore(paths));
    const doctor = admin.modelDoctor();
    expect(doctor).toEqual({
      configured: true,
      provider: "openai-compatible",
      model: "deepseek-v4-flash",
      host: "api.deepseek.com",
      allowlisted: true,
    });
    expect(JSON.stringify(doctor)).not.toContain("secret");
  });

  it("modelDoctor 未配置 → allowlisted false", () => {
    const admin = new AdminService(paths, audit, UNCONFIGURED, [], new UserStore(paths));
    expect(admin.modelDoctor().allowlisted).toBe(false);
  });

  it("listUsers 首次预置三角色，且不回 pwd_hash", async () => {
    const admin = new AdminService(paths, audit, UNCONFIGURED, [], new UserStore(paths));
    const users = await admin.listUsers();
    expect(users.map((u) => u.role).sort()).toEqual(["admin", "operator", "security"]);
    expect(JSON.stringify(users)).not.toContain("pwd_hash");
  });

  it("listPrompts 返回内置只读基线", () => {
    const admin = new AdminService(paths, audit, UNCONFIGURED, [], new UserStore(paths));
    expect(admin.listPrompts().length).toBeGreaterThan(0);
  });

  it("createUser → 列表可见 + 入审计 + 新账号可登录", async () => {
    const users = new UserStore(paths);
    const admin = new AdminService(paths, audit, UNCONFIGURED, [], users);
    const created = await admin.createUser(ADMIN, { id: "zhang", name: "张三", role: "operator", clearance: "secret", password: "zhang-pwd" });
    expect(created).toMatchObject({ id: "zhang", role: "operator", clearance: "secret", enabled: true });
    expect(JSON.stringify(created)).not.toContain("pwd_hash");
    expect((await admin.listUsers()).some((u) => u.id === "zhang")).toBe(true);
    expect((await audit.readAll()).some((e) => e.action === "user.create")).toBe(true);
    const auth = new AuthService(users, audit);
    expect((await auth.login("zhang", "zhang-pwd")).identity).toMatchObject({ id: "zhang", role: "operator" });
  });

  it("createUser 账号重复 → 409", async () => {
    const admin = new AdminService(paths, audit, UNCONFIGURED, [], new UserStore(paths));
    await expect(admin.createUser(ADMIN, { id: "operator", name: "x", role: "operator", clearance: "internal", password: "p" })).rejects.toMatchObject({ status: 409 });
  });

  it("updateUser 改角色/密级/启停并入审计；停用账号被拒登录", async () => {
    const users = new UserStore(paths);
    const admin = new AdminService(paths, audit, UNCONFIGURED, [], users);
    const u = await admin.updateUser(ADMIN, "operator", { role: "security", clearance: "topsecret", enabled: false });
    expect(u).toMatchObject({ role: "security", clearance: "topsecret", enabled: false });
    expect((await audit.readAll()).some((e) => e.action === "user.update")).toBe(true);
    const auth = new AuthService(users, audit);
    await expect(auth.login("operator", "operator123")).rejects.toMatchObject({ status: 401 });
  });

  it("禁止停用/改角色当前登录账号（防自锁）", async () => {
    const admin = new AdminService(paths, audit, UNCONFIGURED, [], new UserStore(paths));
    await expect(admin.updateUser(ADMIN, "admin", { enabled: false })).rejects.toMatchObject({ status: 400 });
    await expect(admin.updateUser(ADMIN, "admin", { role: "operator" })).rejects.toMatchObject({ status: 400 });
  });

  it("resetPassword：旧口令失效，新口令可登录", async () => {
    const users = new UserStore(paths);
    const admin = new AdminService(paths, audit, UNCONFIGURED, [], users);
    await admin.resetPassword(ADMIN, "operator", "brand-new-pwd");
    const auth = new AuthService(users, audit);
    await expect(auth.login("operator", "operator123")).rejects.toMatchObject({ status: 401 });
    expect((await auth.login("operator", "brand-new-pwd")).token).toBeTruthy();
    expect((await audit.readAll()).some((e) => e.action === "user.password")).toBe(true);
  });
});
