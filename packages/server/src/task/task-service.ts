import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { FileMutationQueue } from "mini-agent";

import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import { AppError } from "../domain/identity.js";
import type {
  CaseManifest,
  Identity,
  ReportStatus,
  TaskRun,
  TaskStageState,
  TaskTemplate,
} from "../domain/types.js";
import { readFindings } from "../finding/finding-store.js";
import { writeFileAtomic } from "../util/atomic.js";
import { shortId } from "../util/hash.js";

export const MULTI_SOURCE_VERIFICATION_TEMPLATE: TaskTemplate = {
  id: "multi-source-verification",
  name: "多源事件核验",
  stages: [
    { key: "material-ingest", name: "素材导入" },
    { key: "quality-check", name: "加工质量检查" },
    { key: "evidence-units", name: "证据单元" },
    { key: "entity-merge", name: "实体归并", checkpoint: true },
    { key: "proposition-extraction", name: "命题抽取" },
    { key: "contradiction-detection", name: "矛盾检测", checkpoint: true },
    { key: "assessment", name: "研判结论" },
    { key: "report-generation", name: "报告生成" },
    { key: "review-export", name: "复核导出" },
  ],
};

export type TaskAdvanceStatus = "done" | "failed" | "skipped";

export interface AdvanceStageInput {
  status?: TaskAdvanceStatus;
}

export interface TaskRunOverview {
  currentStage: TaskStageState | null;
  completedStageCount: number;
  totalStageCount: number;
  pendingCheckpointCount: number;
  materials: { total: number; pending: number; processing: number; done: number; failed: number };
  highSeverityContradictionCount: number;
  reportStatus: ReportStatus | null;
}

export interface TaskRunSnapshot {
  template: TaskTemplate;
  run: TaskRun;
  overview: TaskRunOverview;
}

export interface CreateTaskRunResult extends TaskRunSnapshot {
  created: boolean;
}

interface CaseFacts {
  materialCount: number;
  materials: TaskRunOverview["materials"];
  hasQualitySignal: boolean;
  elementCount: number;
  contradictionStatus: string | null;
  highSeverityContradictionCount: number;
  reportStatus: ReportStatus | null;
  approvedFindingCount: number;
}

interface ContradictionResultLike {
  status?: string;
  contradictions?: Array<{ confidence?: number }>;
}

interface ReportRecordLike {
  status?: ReportStatus;
}

export class TaskService {
  private readonly queue = new FileMutationQueue();

  constructor(
    private readonly paths: DataPaths,
    private readonly audit: AuditService,
    private readonly cases: CaseService,
  ) {}

  async createRun(actor: Identity, caseId: string, templateId = MULTI_SOURCE_VERIFICATION_TEMPLATE.id): Promise<CreateTaskRunResult> {
    if (templateId !== MULTI_SOURCE_VERIFICATION_TEMPLATE.id) throw new AppError(400, "未知任务模板");
    const manifest = await this.cases.get(actor, caseId);
    await this.assertCanMutate(actor, manifest, "task.run.create");

    const file = this.runsFile(caseId);
    const { run, created } = await this.queue.runExclusive(file, async () => {
      const runs = await this.readRuns(caseId);
      const active = runs.find((item) => item.caseId === caseId && item.templateId === templateId && item.status === "active");
      if (active) return { run: active, created: false };
      const now = new Date().toISOString();
      const run: TaskRun = {
        id: shortId("task-"),
        caseId,
        templateId,
        status: "active",
        stages: MULTI_SOURCE_VERIFICATION_TEMPLATE.stages.map((stage, index) => ({
          key: stage.key,
          name: stage.name,
          status: index === 0 ? "active" : "pending",
          ...(stage.checkpoint ? { checkpoint: true } : {}),
        })),
        createdAt: now,
      };
      runs.push(run);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFileAtomic(file, `${JSON.stringify(runs, null, 2)}\n`);
      return { run, created: true };
    });
    if (created) {
      await this.audit.append({
        user: actor.id,
        action: "task.run.create",
        object: `task-run:${run.id}`,
        caseId,
        detail: { caseId, runId: run.id, templateId },
      });
    }
    return { ...(await this.getRun(actor, caseId, run.id)), created };
  }

  async getCurrentRun(actor: Identity, caseId: string): Promise<TaskRunSnapshot | null> {
    await this.cases.get(actor, caseId);
    const run = (await this.readRuns(caseId)).find((item) => item.caseId === caseId && item.status === "active");
    return run ? this.snapshot(caseId, run) : null;
  }

  async getRun(actor: Identity, caseId: string, runId: string): Promise<TaskRunSnapshot> {
    await this.cases.get(actor, caseId);
    const run = await this.requireRun(caseId, runId);
    return this.snapshot(caseId, run);
  }

  async advanceStage(actor: Identity, caseId: string, runId: string, stageKey: string, input: AdvanceStageInput): Promise<TaskRunSnapshot> {
    const manifest = await this.cases.get(actor, caseId);
    await this.assertCanMutate(actor, manifest, "task.stage.advance", { runId, stageKey });
    const nextStatus = input.status ?? "done";
    if (nextStatus !== "done" && nextStatus !== "failed" && nextStatus !== "skipped") throw new AppError(400, "非法阶段状态");

    await this.mutateRun(caseId, runId, async (run) => {
      const facts = await this.readFacts(caseId);
      const computed = this.computeStages(run, facts).find((stage) => stage.key === stageKey);
      if (!computed || computed.status !== "active") {
        await this.audit.append({
          user: actor.id,
          action: "task.stage.advance",
          object: `task-run:${runId}`,
          result: "deny",
          caseId,
          detail: { caseId, runId, stageKey, status: nextStatus, reason: "stage-not-active" },
        });
        throw new AppError(409, "只能推进当前阶段");
      }
      const stage = this.requireStage(run, stageKey);
      if (stage.checkpoint && nextStatus === "skipped") {
        await this.audit.append({
          user: actor.id,
          action: "task.stage.advance",
          object: `task-run:${runId}`,
          result: "deny",
          caseId,
          detail: { caseId, runId, stageKey, status: nextStatus, reason: "checkpoint-skip" },
        });
        throw new AppError(409, "人工检查点不能跳过");
      }
      if (stage.checkpoint && nextStatus === "done" && !stage.confirmedAt) {
        await this.audit.append({
          user: actor.id,
          action: "task.stage.advance",
          object: `task-run:${runId}`,
          result: "deny",
          caseId,
          detail: { caseId, runId, stageKey, status: nextStatus, reason: "checkpoint-unconfirmed" },
        });
        throw new AppError(409, "检查点需先确认");
      }
      stage.status = nextStatus;
    });
    await this.audit.append({
      user: actor.id,
      action: "task.stage.advance",
      object: `task-run:${runId}`,
      result: nextStatus === "failed" ? "error" : "ok",
      caseId,
      detail: { caseId, runId, stageKey, status: nextStatus },
    });
    return this.getRun(actor, caseId, runId);
  }

  async confirmStage(actor: Identity, caseId: string, runId: string, stageKey: string): Promise<TaskRunSnapshot> {
    const manifest = await this.cases.get(actor, caseId);
    await this.assertCanMutate(actor, manifest, "task.stage.confirm", { runId, stageKey });
    await this.mutateRun(caseId, runId, async (stored) => {
      const target = this.requireStage(stored, stageKey);
      if (!target.checkpoint) throw new AppError(400, "该阶段不是人工检查点");
      const facts = await this.readFacts(caseId);
      const computed = this.computeStages(stored, facts).find((item) => item.key === stageKey);
      if (computed?.status !== "active" && computed?.status !== "done") {
        await this.audit.append({
          user: actor.id,
          action: "task.stage.confirm",
          object: `task-run:${runId}`,
          result: "deny",
          caseId,
          detail: { caseId, runId, stageKey, reason: "checkpoint-not-reachable" },
        });
        throw new AppError(409, "检查点尚未到达");
      }
      if (!this.checkpointReady(stageKey, facts)) {
        await this.audit.append({
          user: actor.id,
          action: "task.stage.confirm",
          object: `task-run:${runId}`,
          result: "deny",
          caseId,
          detail: { caseId, runId, stageKey, reason: "checkpoint-not-ready" },
        });
        throw new AppError(409, "检查点尚无可确认的前置产物");
      }
      target.confirmedBy = actor.id;
      target.confirmedAt = new Date().toISOString();
      target.status = "done";
    });
    await this.audit.append({
      user: actor.id,
      action: "task.stage.confirm",
      object: `task-run:${runId}`,
      caseId,
      detail: { caseId, runId, stageKey },
    });
    return this.getRun(actor, caseId, runId);
  }

  private async snapshot(caseId: string, stored: TaskRun): Promise<TaskRunSnapshot> {
    if (stored.caseId !== caseId) throw new AppError(404, "任务不存在");
    const facts = await this.readFacts(caseId);
    const stages = this.computeStages(stored, facts);
    const status = stages.some((stage) => stage.status === "failed")
      ? "failed"
      : stages.every((stage) => stage.status === "done" || stage.status === "skipped")
        ? "done"
        : "active";
    const run: TaskRun = { ...stored, status, stages };
    return {
      template: MULTI_SOURCE_VERIFICATION_TEMPLATE,
      run,
      overview: this.overview(stages, facts),
    };
  }

  private computeStages(run: TaskRun, facts: CaseFacts): TaskStageState[] {
    let blocked = false;
    return MULTI_SOURCE_VERIFICATION_TEMPLATE.stages.map((def): TaskStageState => {
      const stored = run.stages.find((stage) => stage.key === def.key);
      const base: TaskStageState = {
        key: def.key,
        name: def.name,
        status: "pending",
        ...(def.checkpoint ? { checkpoint: true } : {}),
        ...(stored?.confirmedBy ? { confirmedBy: stored.confirmedBy } : {}),
        ...(stored?.confirmedAt ? { confirmedAt: stored.confirmedAt } : {}),
      };

      if (blocked) return base;

      if (stored?.status === "failed" || stored?.status === "skipped") {
        base.status = stored.status;
      } else if (def.key === "contradiction-detection" && facts.contradictionStatus === "failed") {
        base.status = "failed";
      } else if (def.checkpoint) {
        base.status = stored?.confirmedAt ? "done" : "active";
      } else if (stored?.status === "done" || this.derivedDone(def.key, facts)) {
        base.status = "done";
      } else {
        base.status = "active";
      }

      if (base.status !== "done" && base.status !== "skipped") blocked = true;
      return base;
    });
  }

  private overview(stages: TaskStageState[], facts: CaseFacts): TaskRunOverview {
    return {
      currentStage: stages.find((stage) => stage.status === "active") ?? null,
      completedStageCount: stages.filter((stage) => stage.status === "done" || stage.status === "skipped").length,
      totalStageCount: stages.length,
      pendingCheckpointCount: stages.filter((stage) => stage.checkpoint && stage.status !== "done" && stage.status !== "skipped").length,
      materials: facts.materials,
      highSeverityContradictionCount: facts.highSeverityContradictionCount,
      reportStatus: facts.reportStatus,
    };
  }

  private derivedDone(stageKey: string, facts: CaseFacts): boolean {
    switch (stageKey) {
      case "material-ingest":
        return facts.materialCount > 0;
      case "quality-check":
        return facts.hasQualitySignal;
      case "evidence-units":
        return facts.elementCount > 0;
      case "assessment":
        return facts.approvedFindingCount > 0;
      case "report-generation":
        return facts.reportStatus === "approved" || facts.reportStatus === "exported";
      case "review-export":
        return facts.reportStatus === "exported";
      default:
        return false;
    }
  }

  private checkpointReady(stageKey: string, facts: CaseFacts): boolean {
    if (stageKey === "entity-merge") return facts.elementCount > 0;
    if (stageKey === "contradiction-detection") return facts.contradictionStatus === "succeeded" || facts.contradictionStatus === "degraded";
    return false;
  }

  private async readFacts(caseId: string): Promise<CaseFacts> {
    const manifest = await this.cases.loadManifest(caseId);
    if (!manifest) throw new AppError(404, "专题不存在");
    const materials = {
      total: manifest.materials.length,
      pending: manifest.materials.filter((m) => m.status === "pending").length,
      processing: manifest.materials.filter((m) => m.status === "processing").length,
      done: manifest.materials.filter((m) => m.status === "done").length,
      failed: manifest.materials.filter((m) => m.status === "failed").length,
    };
    const contradictionResult = await this.readJson<ContradictionResultLike>(path.join(this.paths.caseDir(caseId), "contradictions.result.json"));
    const contradictions = Array.isArray(contradictionResult?.contradictions) ? contradictionResult.contradictions : [];
    const report = await this.readJson<ReportRecordLike>(path.join(this.paths.caseDir(caseId), "report", "report.json"));
    return {
      materialCount: manifest.materials.length,
      materials,
      hasQualitySignal: manifest.materials.some((m) => {
        const legacy = m as typeof m & { processedAt?: unknown; extractedElements?: unknown };
        return Boolean(m.processed_at || legacy.processedAt || legacy.extractedElements || (m.status === "done" && (m.chunk_count ?? 0) > 0));
      }),
      elementCount: await this.countJsonArray(path.join(this.paths.caseDir(caseId), "elements.json")),
      contradictionStatus: typeof contradictionResult?.status === "string" ? contradictionResult.status : null,
      highSeverityContradictionCount: contradictions.filter((item) => (item.confidence ?? 0) >= 0.75).length,
      reportStatus: isReportStatus(report?.status) ? report.status : null,
      approvedFindingCount: await this.countApprovedFindings(caseId),
    };
  }

  private async countJsonArray(file: string): Promise<number> {
    const value = await this.readJson<unknown>(file);
    return Array.isArray(value) ? value.length : 0;
  }

  private async countApprovedFindings(caseId: string): Promise<number> {
    return (await readFindings(this.paths, caseId)).filter((finding) => finding.review_status === "approved").length;
  }

  private async readJson<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  private async assertCanMutate(actor: Identity, manifest: CaseManifest, action: string, detail: Record<string, unknown> = {}): Promise<void> {
    if (actor.role === "admin" || actor.id === manifest.owner) return;
    await this.audit.append({
      user: actor.id,
      action,
      object: `case:${manifest.id}`,
      result: "deny",
      caseId: manifest.id,
      detail: { caseId: manifest.id, reason: "not-owner", ...detail },
    });
    throw new AppError(403, "仅创建者或管理员可操作任务");
  }

  private async requireRun(caseId: string, runId: string): Promise<TaskRun> {
    const run = (await this.readRuns(caseId)).find((item) => item.id === runId);
    if (!run || run.caseId !== caseId) throw new AppError(404, "任务不存在");
    return run;
  }

  private requireStage(run: TaskRun, stageKey: string): TaskStageState {
    const stage = run.stages.find((item) => item.key === stageKey);
    if (!stage) throw new AppError(404, "任务阶段不存在");
    return stage;
  }

  private async mutateRun(caseId: string, runId: string, mutate: (run: TaskRun) => void | Promise<void>): Promise<void> {
    await this.mutateRuns(caseId, (runs) => {
      const run = runs.find((item) => item.id === runId);
      if (!run || run.caseId !== caseId) throw new AppError(404, "任务不存在");
      return mutate(run);
    });
  }

  private async mutateRuns<T>(caseId: string, mutate: (runs: TaskRun[]) => T | Promise<T>): Promise<T> {
    const file = this.runsFile(caseId);
    return this.queue.runExclusive(file, async () => {
      const runs = await this.readRuns(caseId);
      const result = await mutate(runs);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFileAtomic(file, `${JSON.stringify(runs, null, 2)}\n`);
      return result;
    });
  }

  private async readRuns(caseId: string): Promise<TaskRun[]> {
    const runs = await this.readJson<TaskRun[]>(this.runsFile(caseId));
    return Array.isArray(runs) ? runs : [];
  }

  private runsFile(caseId: string): string {
    return path.join(this.paths.caseDir(caseId), "task-runs.json");
  }
}

function isReportStatus(value: unknown): value is ReportStatus {
  return value === "draft" || value === "in_review" || value === "approved" || value === "exported";
}
