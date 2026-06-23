import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Contradiction, Element, Finding, Identity, Material, ReportRecord } from "../src/domain/types.js";
import { createTaskRouter } from "../src/routes/tasks.js";
import { MULTI_SOURCE_VERIFICATION_TEMPLATE, TaskService } from "../src/task/task-service.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const STRANGER: Identity = { id: "other", name: "other", role: "operator", clearance: "internal" };

function stageStatus(run: { stages: { key: string; status: string }[] }, key: string): string | undefined {
  return run.stages.find((stage) => stage.key === key)?.status;
}

function material(caseId: string, patch: Partial<Material> = {}): Material {
  return {
    id: "m-1",
    case_id: caseId,
    filename: "intel.txt",
    modality: "doc",
    format: "txt",
    size: 12,
    ingested_at: new Date().toISOString(),
    status: "pending",
    ...patch,
  };
}

function element(): Element {
  return {
    id: "el-1",
    type: "event",
    name: "事件甲",
    aliases: [],
    mentions: [],
    freq: 1,
  };
}

function contradiction(confidence = 0.9): Contradiction {
  const citation = {
    material_id: "m-1",
    material_name: "intel.txt",
    modality: "doc" as const,
    locator: { paragraph: 1 },
    snippet: "线索",
    confidence: 1,
    content_hash: "h",
  };
  return {
    id: "ct-1",
    entity: "目标甲",
    scope: "cross-material",
    claim_a: { text: "A", citation },
    claim_b: { text: "B", citation },
    relation: "contradiction",
    rationale: "冲突",
    confidence,
  };
}

function finding(caseId: string): Finding {
  const citation = {
    material_id: "m-1",
    material_name: "intel.txt",
    modality: "doc" as const,
    locator: { paragraph: 1 },
    snippet: "目标甲在码头出现。",
    confidence: 1,
    content_hash: "h",
  };
  return {
    id: "f-1",
    caseId,
    conclusion: "目标甲在码头出现。",
    supporting_citations: [citation],
    opposing_citations: [],
    confidence: 0.9,
    review_status: "approved",
    reviewed_by: "sec",
    reviewed_at: new Date().toISOString(),
    open_questions: [],
  };
}

describe("TaskService（Batch D 任务编排层）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let tasks: TaskService;
  let caseId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-task-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    tasks = new TaskService(paths, audit, cases);
    caseId = (await cases.create(OPERATOR, { name: "任务专题", clearance: "internal" })).id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeCaseJson(file: string, value: unknown): Promise<void> {
    const target = path.join(paths.caseDir(caseId), file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  it("createRun 创建单一内置模板，阶段顺序与初始状态正确", async () => {
    const { run } = await tasks.createRun(OPERATOR, caseId);

    expect(run.templateId).toBe(MULTI_SOURCE_VERIFICATION_TEMPLATE.id);
    expect(run.stages.map((stage) => stage.name)).toEqual([
      "素材导入",
      "加工质量检查",
      "证据单元",
      "实体归并",
      "命题抽取",
      "矛盾检测",
      "研判结论",
      "报告生成",
      "复核导出",
    ]);
    expect(run.stages.map((stage) => stage.status)).toEqual([
      "active",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(run.stages.filter((stage) => stage.checkpoint).map((stage) => stage.key)).toEqual([
      "entity-merge",
      "contradiction-detection",
    ]);
  });

  it("getRun 只从真实产物派生阶段，不用证据单元伪造命题抽取完成", async () => {
    await cases.attachMaterial(caseId, material(caseId, { status: "done", chunk_count: 1, processed_at: new Date().toISOString() }));
    await writeCaseJson("elements.json", [element()]);
    await writeCaseJson("contradictions.result.json", {
      status: "succeeded",
      contradictions: [contradiction()],
      processedChunks: 1,
      totalChunks: 1,
      truncated: false,
      warnings: [],
    });

    const created = await tasks.createRun(OPERATOR, caseId);
    await tasks.confirmStage(OPERATOR, caseId, created.run.id, "entity-merge");

    const { run, overview } = await tasks.getRun(OPERATOR, caseId, created.run.id);

    expect(stageStatus(run, "material-ingest")).toBe("done");
    expect(stageStatus(run, "quality-check")).toBe("done");
    expect(stageStatus(run, "evidence-units")).toBe("done");
    expect(stageStatus(run, "proposition-extraction")).toBe("active");
    expect(stageStatus(run, "contradiction-detection")).toBe("pending");
    expect(overview.highSeverityContradictionCount).toBe(1);
  });

  it("failed 矛盾检测结果会显式派生失败阶段", async () => {
    await cases.attachMaterial(caseId, material(caseId, { status: "done", chunk_count: 1, processed_at: new Date().toISOString() }));
    await writeCaseJson("elements.json", [element()]);
    await writeCaseJson("contradictions.result.json", {
      status: "failed",
      contradictions: [],
      processedChunks: 0,
      totalChunks: 1,
      truncated: false,
      warnings: [],
      error: "模型失败",
    });

    const created = await tasks.createRun(OPERATOR, caseId);
    await tasks.confirmStage(OPERATOR, caseId, created.run.id, "entity-merge");
    await tasks.advanceStage(OPERATOR, caseId, created.run.id, "proposition-extraction", {});

    const { run } = await tasks.getRun(OPERATOR, caseId, created.run.id);

    expect(stageStatus(run, "contradiction-detection")).toBe("failed");
    expect(run.status).toBe("failed");
  });

  it("advance 拒绝未确认检查点，不记录成功推进审计", async () => {
    await cases.attachMaterial(caseId, material(caseId, { status: "done", chunk_count: 1, processed_at: new Date().toISOString() }));
    await writeCaseJson("elements.json", [element()]);
    await writeCaseJson("contradictions.result.json", {
      status: "succeeded",
      contradictions: [contradiction()],
      processedChunks: 1,
      totalChunks: 1,
      truncated: false,
      warnings: [],
    });

    const created = await tasks.createRun(OPERATOR, caseId);
    await tasks.confirmStage(OPERATOR, caseId, created.run.id, "entity-merge");
    await tasks.advanceStage(OPERATOR, caseId, created.run.id, "proposition-extraction", {});

    await expect(tasks.advanceStage(OPERATOR, caseId, created.run.id, "contradiction-detection", {})).rejects.toMatchObject({ status: 409 });
    const advanceEvents = (await audit.readCaseEvents(caseId)).filter(
      (event) => event.action === "task.stage.advance" && event.detail?.stageKey === "contradiction-detection",
    );
    expect(advanceEvents.some((event) => event.result === "ok")).toBe(false);
    expect(advanceEvents.some((event) => event.result === "deny")).toBe(true);

    const confirmed = await tasks.confirmStage(OPERATOR, caseId, created.run.id, "contradiction-detection");
    expect(stageStatus(confirmed.run, "contradiction-detection")).toBe("done");
    expect(confirmed.run.stages.find((stage) => stage.key === "contradiction-detection")?.confirmedBy).toBe("op");
  });

  it("createRun 对同一专题的活动任务保持幂等", async () => {
    const first = await tasks.createRun(OPERATOR, caseId);
    const second = await tasks.createRun(OPERATOR, caseId);

    expect(second.run.id).toBe(first.run.id);
    expect((await audit.readCaseEvents(caseId)).filter((event) => event.action === "task.run.create")).toHaveLength(1);
  });

  it("getCurrentRun 只读取当前活动任务，不创建任务或审计", async () => {
    const empty = await tasks.getCurrentRun(OPERATOR, caseId);
    expect(empty).toBeNull();
    expect((await audit.readCaseEvents(caseId)).filter((event) => event.action === "task.run.create")).toHaveLength(0);

    const created = await tasks.createRun(OPERATOR, caseId);
    const current = await tasks.getCurrentRun(OPERATOR, caseId);

    expect(current?.run.id).toBe(created.run.id);
    expect((await audit.readCaseEvents(caseId)).filter((event) => event.action === "task.run.create")).toHaveLength(1);
  });

  it("advance 推进活动阶段，skip 将阶段标记为 skipped", async () => {
    const created = await tasks.createRun(OPERATOR, caseId);

    const advanced = await tasks.advanceStage(OPERATOR, caseId, created.run.id, "material-ingest", {});
    expect(stageStatus(advanced.run, "material-ingest")).toBe("done");
    expect(stageStatus(advanced.run, "quality-check")).toBe("active");

    const skipped = await tasks.advanceStage(OPERATOR, caseId, created.run.id, "quality-check", { status: "skipped" });
    expect(stageStatus(skipped.run, "quality-check")).toBe("skipped");
    expect(stageStatus(skipped.run, "evidence-units")).toBe("active");
  });

  it("所有 run/stage/checkpoint 变更均写入专题审计", async () => {
    const created = await tasks.createRun(OPERATOR, caseId);
    await tasks.advanceStage(OPERATOR, caseId, created.run.id, "material-ingest", {});
    await tasks.advanceStage(OPERATOR, caseId, created.run.id, "quality-check", { status: "skipped" });

    await cases.attachMaterial(caseId, material(caseId, { status: "done", chunk_count: 1, processed_at: new Date().toISOString() }));
    await writeCaseJson("elements.json", [element()]);
    await tasks.confirmStage(OPERATOR, caseId, created.run.id, "entity-merge");
    await tasks.advanceStage(OPERATOR, caseId, created.run.id, "proposition-extraction", {});

    const actions = (await audit.readCaseEvents(caseId)).map((event) => event.action);
    expect(actions).toContain("task.run.create");
    expect(actions.filter((action) => action === "task.stage.advance")).toHaveLength(3);
    expect(actions).toContain("task.stage.confirm");
  });

  it("任务端点拒绝非 owner 变更与 cross-case run 访问", async () => {
    const otherCaseId = (await cases.create(OPERATOR, { name: "另一个专题", clearance: "internal" })).id;
    const created = await tasks.createRun(OPERATOR, caseId);
    const router = createTaskRouter(tasks);

    const createLayer = (router as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: Function }> } }> }).stack.find((item) => item.route?.path === "/:id/task-runs");
    const getLayer = (router as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: Function }> } }> }).stack.find((item) => item.route?.path === "/:id/task-runs/:runId");

    await expect(createLayer?.route?.stack[0].handle(
      { identity: STRANGER, params: { id: caseId }, body: {} },
      { status: vi.fn().mockReturnThis(), json: vi.fn() },
      vi.fn(),
    )).rejects.toMatchObject({ status: 403 });

    await expect(getLayer?.route?.stack[0].handle(
      { identity: OPERATOR, params: { id: otherCaseId, runId: created.run.id } },
      { json: vi.fn() },
      vi.fn(),
    )).rejects.toMatchObject({ status: 404 });
  });

  it("已复核或已导出的报告派生报告生成阶段，已导出派生复核导出阶段", async () => {
    await cases.attachMaterial(caseId, material(caseId, { status: "done", chunk_count: 1, processed_at: new Date().toISOString() }));
    await writeCaseJson("elements.json", [element()]);
    await writeCaseJson("contradictions.result.json", {
      status: "succeeded",
      contradictions: [contradiction(0.5)],
      processedChunks: 1,
      totalChunks: 1,
      truncated: false,
      warnings: [],
    });
    const report: ReportRecord = {
      status: "exported",
      spec: {
        title: "通报",
        sections: [{
          heading: "正文",
          body: "内容",
          finding_ids: [],
          citation_ids: [],
          coverage_status: "uncovered",
        }],
      },
      drafted_by: "op",
      drafted_at: new Date().toISOString(),
      rendered: true,
      exported_by: "op",
      exported_at: new Date().toISOString(),
    };
    await writeCaseJson("report/report.json", report);

    const created = await tasks.createRun(OPERATOR, caseId);
    await tasks.confirmStage(OPERATOR, caseId, created.run.id, "entity-merge");
    await tasks.advanceStage(OPERATOR, caseId, created.run.id, "proposition-extraction", {});
    await tasks.confirmStage(OPERATOR, caseId, created.run.id, "contradiction-detection");
    await tasks.advanceStage(OPERATOR, caseId, created.run.id, "assessment", {});
    const { run, overview } = await tasks.getRun(OPERATOR, caseId, created.run.id);

    expect(stageStatus(run, "report-generation")).toBe("done");
    expect(stageStatus(run, "review-export")).toBe("done");
    expect(overview.reportStatus).toBe("exported");
  });

  it("至少一个已审核 Finding 会派生研判结论阶段完成", async () => {
    await cases.attachMaterial(caseId, material(caseId, { status: "done", chunk_count: 1, processed_at: new Date().toISOString() }));
    await writeCaseJson("elements.json", [element()]);
    await writeCaseJson("contradictions.result.json", {
      status: "succeeded",
      contradictions: [contradiction(0.5)],
      processedChunks: 1,
      totalChunks: 1,
      truncated: false,
      warnings: [],
    });
    await writeCaseJson("findings.json", [finding(caseId)]);

    const created = await tasks.createRun(OPERATOR, caseId);
    await tasks.confirmStage(OPERATOR, caseId, created.run.id, "entity-merge");
    await tasks.advanceStage(OPERATOR, caseId, created.run.id, "proposition-extraction", {});
    await tasks.confirmStage(OPERATOR, caseId, created.run.id, "contradiction-detection");
    const { run } = await tasks.getRun(OPERATOR, caseId, created.run.id);

    expect(stageStatus(run, "assessment")).toBe("done");
    expect(stageStatus(run, "report-generation")).toBe("active");
  });
});
