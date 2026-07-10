import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { StatusService } from "../src/brief/status-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Identity } from "../src/domain/types.js";
import { MaterialService } from "../src/materials/material-service.js";

/**
 * StatusService 测试（破坏性收敛 R2 · 批次 D）。GET /cases/:id/status 每节按落盘事实三态：
 * 缺产物 = not_started；损坏/读失败 = error + message；有产物 = ready + 数据。绝不把错误转零值。
 * 覆盖：初始三态、有产物 ready、损坏文件 error（含 workflow.json 契约违背）、密级读权限收口。
 */

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const TOPSECRET: Identity = { id: "boss", name: "boss", role: "operator", clearance: "topsecret" };

const VALID_WORKFLOW = {
  inputHash: "h1",
  steps: {
    elements: { status: "succeeded" },
    contradictions: { status: "succeeded" },
    inquiries: { status: "idle", items: [] },
  },
  checkpoints: {},
};

describe("StatusService（专题聚合状态端点）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let materials: MaterialService;
  let status: StatusService;
  let caseId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-status-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    materials = new MaterialService(paths, audit, cases);
    status = new StatusService(paths, cases, audit);

    caseId = (await cases.create(OPERATOR, { name: "状态专题", clearance: "internal" })).id;
    await materials.ingest(OPERATOR, caseId, [{ filename: "intel.txt", content: "目标甲于码头出现。" }]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeCaseFile(rel: string, contents: string): Promise<void> {
    const target = path.join(paths.caseDir(caseId), rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }

  async function writeCaseJson(rel: string, value: unknown): Promise<void> {
    await writeCaseFile(rel, `${JSON.stringify(value, null, 2)}\n`);
  }

  it("初始三态：素材/审计 ready，未生成的产物为 not_started（非零值）", async () => {
    const payload = await status.getStatus(OPERATOR, caseId);

    expect(payload.materials).toEqual({ state: "ready", total: 1, processed: 1, failed: 0 });
    expect(payload.workflow).toEqual({ state: "not_started" });
    expect(payload.contradictions).toEqual({ state: "not_started" });
    expect(payload.findings).toEqual({ state: "not_started" });
    expect(payload.report).toEqual({ state: "not_started" });
    expect(payload.audit.state).toBe("ready");
    expect((payload.audit as { count: number }).count).toBeGreaterThanOrEqual(1);
  });

  it("有产物 → 各节 ready 且数值准确（高置信阈值 0.75 + 处置态过滤）", async () => {
    await writeCaseJson("workflow.json", VALID_WORKFLOW);
    await writeCaseJson("contradictions.result.json", {
      status: "succeeded",
      contradictions: [
        { id: "ct-1", confidence: 0.9 },
        { id: "ct-2", confidence: 0.8 },
        { id: "ct-3", confidence: 0.5 },
      ],
    });
    await writeCaseJson("contradiction-acks.json", [
      { id: "ca-1", case_id: caseId, contradiction_id: "ct-2", status: "resolved", note: "", by: "sec", at: "2026-03-02T00:00:00.000Z" },
    ]);
    await writeCaseJson("findings.json", [
      { id: "f1", caseId, conclusion: "a", supporting_citations: [], opposing_citations: [], confidence: 0.8, review_status: "approved", open_questions: [] },
      { id: "f2", caseId, conclusion: "b", supporting_citations: [], opposing_citations: [], confidence: 0.8, review_status: "draft", open_questions: [] },
      { id: "f3", caseId, conclusion: "c", supporting_citations: [], opposing_citations: [], confidence: 0.8, review_status: "rejected", open_questions: [] },
    ]);
    await writeCaseJson("report/report.json", { status: "in_review", spec: { title: "t", sections: [] }, drafted_by: "op", drafted_at: "2026-03-02T00:00:00.000Z", rendered: false });

    const payload = await status.getStatus(OPERATOR, caseId);

    expect(payload.workflow).toMatchObject({ state: "ready", data: { inputHash: "h1" } });
    // total 3；仅 ct-1（0.9 open）计入高置信未处置，ct-2 已处置、ct-3 低置信排除。
    expect(payload.contradictions).toEqual({ state: "ready", total: 3, openHighConfidence: 1 });
    expect(payload.findings).toEqual({ state: "ready", total: 3, approved: 1, pending: 1 });
    expect(payload.report).toMatchObject({ state: "ready", status: "in_review" });
    expect((payload.report as { coverage: { total: number } }).coverage.total).toBe(5);
  });

  it("损坏文件 → 对应节 error + message（绝不转零值/空）", async () => {
    await writeCaseFile("workflow.json", "这不是 JSON{");
    await writeCaseFile("contradictions.result.json", "broken}");
    await writeCaseFile("findings.json", "broken}");
    await writeCaseFile("report/report.json", "broken}");

    const payload = await status.getStatus(OPERATOR, caseId);

    for (const key of ["workflow", "contradictions", "findings", "report"] as const) {
      expect(payload[key].state).toBe("error");
      expect((payload[key] as { message: string }).message).toBeTruthy();
    }
  });

  it("workflow.json 结构违背冻结契约（旧格式）→ error 而非静默零值", async () => {
    await writeCaseJson("workflow.json", { legacy: true });
    const payload = await status.getStatus(OPERATOR, caseId);
    expect(payload.workflow.state).toBe("error");
    expect((payload.workflow as { message: string }).message).toContain("契约");
  });

  it("密级不足 → getStatus 拒绝（沿用现有专题读权限）", async () => {
    const secretCase = (await cases.create(TOPSECRET, { name: "涉密专题", clearance: "secret" })).id;
    await expect(status.getStatus(OPERATOR, secretCase)).rejects.toThrow();
  });
});
