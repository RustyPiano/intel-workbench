import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdminService } from "../src/admin/admin-service.js";
import { AuditService } from "../src/audit/audit-service.js";
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
    const admin = new AdminService(paths, audit, UNCONFIGURED, []);
    const skills = await admin.listSkills();
    const bulletin = skills.find((s) => s.name === "intel-bulletin");
    expect(bulletin).toBeTruthy();
    expect(bulletin?.enabled).toBe(true);
    expect(bulletin?.healthy).toBe(true);
  });

  it("setSkillEnabled 持久化并入审计", async () => {
    const admin = new AdminService(paths, audit, UNCONFIGURED, []);
    await admin.setSkillEnabled(ADMIN, "intel-bulletin", false);
    const skills = await admin.listSkills();
    expect(skills.find((s) => s.name === "intel-bulletin")?.enabled).toBe(false);
    const cfg = JSON.parse(await readFile(path.join(paths.configDir, "skills.json"), "utf8"));
    expect(cfg["intel-bulletin"]).toBe(false);
    expect((await audit.readAll()).some((e) => e.action === "config.skill")).toBe(true);
  });

  it("modelDoctor 脱敏：报告配置与白名单，不含 apiKey", () => {
    const admin = new AdminService(paths, audit, CONFIGURED, ["api.deepseek.com"]);
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
    const admin = new AdminService(paths, audit, UNCONFIGURED, []);
    expect(admin.modelDoctor().allowlisted).toBe(false);
  });

  it("listUsers 首次预置三角色，且不回 pwd_hash", async () => {
    const admin = new AdminService(paths, audit, UNCONFIGURED, []);
    const users = await admin.listUsers();
    expect(users.map((u) => u.role).sort()).toEqual(["admin", "operator", "security"]);
    expect(JSON.stringify(users)).not.toContain("pwd_hash");
  });

  it("listPrompts 返回内置只读基线", () => {
    const admin = new AdminService(paths, audit, UNCONFIGURED, []);
    expect(admin.listPrompts().length).toBeGreaterThan(0);
  });
});
