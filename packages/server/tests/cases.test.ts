import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import { AppError } from "../src/domain/identity.js";
import type { Identity, Material, MaterialStatus } from "../src/domain/types.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "confidential" };
const ADMIN: Identity = { id: "admin", name: "admin", role: "admin", clearance: "topsecret" };

describe("CaseService（M1 数据底座）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;

  function service(devMode: boolean): CaseService {
    return new CaseService(paths, audit, devMode);
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-cases-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("create 落盘 manifest 并 append 审计", async () => {
    const cases = service(false);
    const m = await cases.create(OPERATOR, { name: "测试专题", clearance: "internal" });
    expect(m.owner).toBe("op");
    expect(m.status).toBe("active");
    expect(m.materials).toEqual([]);

    const events = await audit.readAll();
    expect(events.some((e) => e.action === "case.create" && e.detail?.caseId === m.id)).toBe(true);
    // 对账：刚建的专题不应是孤儿。
    expect((await audit.reconcile(await cases.listIds())).ok).toBe(true);
  });

  it("开发模式禁止创建涉密专题，并留 deny 审计（§7.5）", async () => {
    const cases = service(true);
    await expect(cases.create(ADMIN, { name: "涉密", clearance: "secret" })).rejects.toMatchObject({
      status: 403,
    });
    const events = await audit.readAll();
    expect(events.at(-1)).toMatchObject({ action: "case.create", result: "deny" });
  });

  it("非开发模式允许涉密（在自身密级内）", async () => {
    const cases = service(false);
    const m = await cases.create(ADMIN, { name: "机密专题", clearance: "confidential" });
    expect(m.clearance).toBe("confidential");
  });

  it("不得创建高于自身密级的专题", async () => {
    const cases = service(false);
    await expect(cases.create(OPERATOR, { name: "越权", clearance: "topsecret" })).rejects.toBeInstanceOf(AppError);
  });

  it("list 按密级过滤、按更新时间倒序", async () => {
    const cases = service(false);
    await cases.create(ADMIN, { name: "高密", clearance: "topsecret" });
    await cases.create(OPERATOR, { name: "低密", clearance: "internal" });

    const lowView = await cases.list({ ...OPERATOR, clearance: "internal" });
    expect(lowView.map((m) => m.name)).toEqual(["低密"]);

    const highView = await cases.list(ADMIN);
    expect(highView).toHaveLength(2);
  });

  it("update 重命名并记审计；非所有者非管理员被拒", async () => {
    const cases = service(false);
    const m = await cases.create(OPERATOR, { name: "原名", clearance: "internal" });
    const renamed = await cases.update(OPERATOR, m.id, { name: "新名" });
    expect(renamed.name).toBe("新名");

    const stranger: Identity = { id: "other", name: "other", role: "operator", clearance: "topsecret" };
    await expect(cases.update(stranger, m.id, { name: "改不动" })).rejects.toMatchObject({ status: 403 });
  });

  it("get 不存在的专题 → 404", async () => {
    const cases = service(false);
    await expect(cases.get(OPERATOR, "nope")).rejects.toMatchObject({ status: 404 });
  });

  it("拒绝路径穿越的 caseId（红线，不落到文件系统外）", async () => {
    const cases = service(false);
    for (const evil of ["../../etc", "..", "a/b", "x\\y"]) {
      await expect(cases.get(OPERATOR, evil)).rejects.toMatchObject({ status: 400 });
    }
  });
});

describe("CaseService 并发与崩溃恢复（二期 P2.3a 阻塞项）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let caseId: string;

  function mat(id: string, status: MaterialStatus = "done"): Material {
    return { id, case_id: caseId, filename: `${id}.txt`, modality: "doc", format: "txt", size: 1, ingested_at: new Date().toISOString(), status };
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-cc-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    caseId = (await cases.create(OPERATOR, { name: "并发专题", clearance: "internal" })).id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("20 个并发 attachMaterial 不丢素材（串行化）", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => cases.attachMaterial(caseId, mat(`m-${i}`))));
    const loaded = await cases.loadManifest(caseId);
    expect(loaded?.materials).toHaveLength(20);
    expect(new Set(loaded?.materials.map((m) => m.id)).size).toBe(20);
  });

  it("并发 attach 撞 updateMaterial：两个变更都不丢（RMW 串行）", async () => {
    await cases.attachMaterial(caseId, mat("m-A", "done"));
    await Promise.all([
      cases.attachMaterial(caseId, mat("m-B", "done")),
      cases.updateMaterial(caseId, "m-A", (m) => {
        m.status = "processing";
      }),
    ]);
    const loaded = await cases.loadManifest(caseId);
    expect(loaded?.materials.map((m) => m.id).sort()).toEqual(["m-A", "m-B"]);
    expect(loaded?.materials.find((m) => m.id === "m-A")?.status).toBe("processing");
  });

  it("updateMaterial 不存在的素材 → 404", async () => {
    await expect(cases.updateMaterial(caseId, "m-nope", () => {})).rejects.toMatchObject({ status: 404 });
  });

  it("sweepInterrupted：processing → failed 带原因，done 不动", async () => {
    await cases.attachMaterial(caseId, mat("m-stuck", "processing"));
    await cases.attachMaterial(caseId, mat("m-ok", "done"));
    const swept = await cases.sweepInterrupted();
    expect(swept).toEqual([{ caseId, materialId: "m-stuck" }]);
    const loaded = await cases.loadManifest(caseId);
    const stuck = loaded?.materials.find((m) => m.id === "m-stuck");
    expect(stuck?.status).toBe("failed");
    expect(stuck?.note).toBeTruthy();
    expect(loaded?.materials.find((m) => m.id === "m-ok")?.status).toBe("done");
    // 无中断素材时清扫返回空。
    expect(await cases.sweepInterrupted()).toEqual([]);
  });
});
