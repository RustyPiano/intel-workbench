import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Contradiction, Element, Finding, Identity, Material, ReportRecord, TaskRun } from "../src/domain/types.js";
import { MULTI_SOURCE_VERIFICATION_TEMPLATE, TaskService } from "../src/task/task-service.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };

function material(caseId: string): Material {
  return {
    id: "m-1",
    case_id: caseId,
    filename: "intel.txt",
    modality: "doc",
    format: "txt",
    size: 12,
    ingested_at: new Date().toISOString(),
    status: "done",
    chunk_count: 1,
    processed_at: new Date().toISOString(),
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

function contradiction(): Contradiction {
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
    confidence: 0.5,
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

describe("TaskService run persistence", () => {
  let root: string;
  let paths: DataPaths;
  let cases: CaseService;
  let tasks: TaskService;
  let caseId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-task-persist-"));
    paths = resolveDataPaths(root);
    const audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    tasks = new TaskService(paths, audit, cases);
    caseId = (await cases.create(OPERATOR, { name: "任务持久化专题", clearance: "internal" })).id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeCaseJson(file: string, value: unknown): Promise<void> {
    const target = path.join(paths.caseDir(caseId), file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  async function readRuns(): Promise<TaskRun[]> {
    return JSON.parse(await readFile(path.join(paths.caseDir(caseId), "task-runs.json"), "utf8")) as TaskRun[];
  }

  it("persists completed runs so a second run can be created", async () => {
    await cases.attachMaterial(caseId, material(caseId));
    await writeCaseJson("elements.json", [element()]);
    await writeCaseJson("contradictions.result.json", {
      status: "succeeded",
      contradictions: [contradiction()],
      processedChunks: 1,
      totalChunks: 1,
      truncated: false,
      warnings: [],
    });
    await writeCaseJson("findings.json", [finding(caseId)]);
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

    const first = await tasks.createRun(OPERATOR, caseId);
    await tasks.confirmStage(OPERATOR, caseId, first.run.id, "entity-merge");
    await tasks.advanceStage(OPERATOR, caseId, first.run.id, "proposition-extraction", {});
    const completed = await tasks.confirmStage(OPERATOR, caseId, first.run.id, "contradiction-detection");
    expect(completed.run.status).toBe("done");

    const second = await tasks.createRun(OPERATOR, caseId);
    const runs = await readRuns();
    const storedFirst = runs.find((run) => run.id === first.run.id);

    expect(second.created).toBe(true);
    expect(second.run.id).not.toBe(first.run.id);
    expect(storedFirst?.status).toBe("done");
    expect(storedFirst?.completedAt).toEqual(expect.any(String));
    await expect(tasks.getRun(OPERATOR, caseId, first.run.id)).resolves.toMatchObject({ run: { id: first.run.id } });
    await expect(tasks.getRun(OPERATOR, caseId, second.run.id)).resolves.toMatchObject({ run: { id: second.run.id } });
  });

  it("persists failed runs so a second run can be created", async () => {
    const first = await tasks.createRun(OPERATOR, caseId);
    const failed = await tasks.advanceStage(OPERATOR, caseId, first.run.id, "material-ingest", { status: "failed" });
    expect(failed.run.status).toBe("failed");

    const runsAfterFailure = await readRuns();
    const storedFirst = runsAfterFailure.find((run) => run.id === first.run.id);
    expect(storedFirst?.status).toBe("failed");
    expect(storedFirst?.failedAt).toEqual(expect.any(String));
    expect(storedFirst?.failureReason).toBe("素材导入");

    const second = await tasks.createRun(OPERATOR, caseId);

    expect(second.created).toBe(true);
    expect(second.run.id).not.toBe(first.run.id);
  });

  it("does not reuse a stored-active run that is already terminal but never snapshotted", async () => {
    // 落盘 status 仍为 active、但各阶段已实际完成、且从未被 snapshot 读过的运行。
    const now = new Date().toISOString();
    const staleRun: TaskRun = {
      id: "task-stale",
      caseId,
      templateId: MULTI_SOURCE_VERIFICATION_TEMPLATE.id,
      status: "active",
      stages: MULTI_SOURCE_VERIFICATION_TEMPLATE.stages.map((stage) => ({
        key: stage.key,
        name: stage.name,
        status: "done" as const,
        ...(stage.checkpoint ? { checkpoint: true as const, confirmedBy: "op", confirmedAt: now } : {}),
      })),
      createdAt: now,
    };
    await writeCaseJson("task-runs.json", [staleRun]);

    // createRun 必须先重算 candidate 的真实状态，发现已终态 → 回写并新建，而非误复用。
    const second = await tasks.createRun(OPERATOR, caseId);
    expect(second.created).toBe(true);
    expect(second.run.id).not.toBe("task-stale");

    const runs = await readRuns();
    const stale = runs.find((run) => run.id === "task-stale");
    expect(stale?.status).toBe("done");
    expect(stale?.completedAt).toEqual(expect.any(String));
  });

  it("getCurrentRun returns the latest run with its terminal status, not null", async () => {
    const first = await tasks.createRun(OPERATOR, caseId);
    await tasks.advanceStage(OPERATOR, caseId, first.run.id, "material-ingest", { status: "failed" });

    // 终态回写后 getCurrentRun 仍应返回该运行并带 failed 状态（而非 null → UI"尚未开始"）。
    const current = await tasks.getCurrentRun(OPERATOR, caseId);
    expect(current).not.toBeNull();
    expect(current!.run.id).toBe(first.run.id);
    expect(current!.run.status).toBe("failed");
  });
});
