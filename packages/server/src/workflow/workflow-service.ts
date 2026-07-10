import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { FileMutationQueue } from "mini-agent";

import type { ContradictionService } from "../analysis/contradiction-service.js";
import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import { AppError } from "../domain/identity.js";
import type { AuditResult, Identity, Material } from "../domain/types.js";
import type { ElementService } from "../elements/element-service.js";
import type { AutoInquiryService } from "../inquiry/auto-inquiry-service.js";
import type { Job, JobContext, JobRegistry } from "../jobs/job-registry.js";
import { writeFileAtomic } from "../util/atomic.js";
import { sha256, sha256Bytes } from "../util/hash.js";
import { readWorkflowState, type InquiryBatchItem, type WorkflowState, type WorkflowStep } from "./types.js";

/**
 * 专题唯一执行状态 workflow.json 的唯一写者（破坏性收敛 R2）。取代 task-runs.json /
 * autopilot-state.json / auto-inquiry.json 三个并存状态文件，合并「自动流水线编排 + 执行体
 * 生命周期 + 人工检查点」为一份可对账的状态。
 *
 * 三个执行步骤 elements → contradictions → inquiries 都经 JobRegistry.start 运行（复用
 * `/jobs/:kind/cancel` 取消、按 (caseId,kind) 天然去重防自动/手动并发同一步骤）；步骤状态与
 * 检查点以本文件为权威（不再从落盘产物逐次派生）。自动动作以 `system-autopilot` 落审计。
 */

type JobKind = "elements" | "contradictions" | "auto-inquiry";
type StepKey = "elements" | "contradictions" | "inquiries";
type CheckpointKey = "entities" | "contradictions";

const SYSTEM_ACTOR = "system-autopilot";

const STEP_BY_KIND: Record<JobKind, StepKey> = {
  elements: "elements",
  contradictions: "contradictions",
  "auto-inquiry": "inquiries",
};

const KIND_BY_STEP: Record<StepKey, JobKind> = {
  elements: "elements",
  contradictions: "contradictions",
  inquiries: "auto-inquiry",
};

/** 预跑顺序即流水线中「不需人工输入」的执行体（矛盾派生问题价值最高，故自动研判置于矛盾之后）。 */
const PIPELINE: { kind: JobKind; artifact: string | null; checkpoint: CheckpointKey | null }[] = [
  { kind: "elements", artifact: "elements.json", checkpoint: "entities" },
  { kind: "contradictions", artifact: "contradictions.result.json", checkpoint: "contradictions" },
  { kind: "auto-inquiry", artifact: null, checkpoint: null },
];

/** 检查点 ⇄ 其绑定的产物文件（哈希对账用）。 */
const CHECKPOINT_ARTIFACT: Record<CheckpointKey, { kind: JobKind; artifact: string }> = {
  entities: { kind: "elements", artifact: "elements.json" },
  contradictions: { kind: "contradictions", artifact: "contradictions.result.json" },
};

/** 单专题执行进度写入接口（供 AutoInquiryService 逐题回写，避免双写者）。 */
export interface InquiryProgressSink {
  setInquiryItems(caseId: string, items: InquiryBatchItem[]): Promise<void>;
}

function freshState(inputHash: string): WorkflowState {
  return {
    inputHash,
    steps: {
      elements: { status: "idle" },
      contradictions: { status: "idle" },
      inquiries: { status: "idle", items: [] },
    },
    checkpoints: {},
  };
}

/** 素材指纹（沿用原 autopilot 的 materialInputHash 口径）。导出供 demo/seed 写出匹配指纹。 */
export function materialInputHash(materials: Material[]): string {
  const input = materials
    .map((material) => ({
      id: material.id,
      size: material.size,
      status: material.status,
      chunkCount: material.chunk_count ?? 0,
      chunkVersion: material.chunk_version ?? 0,
      processedAt: material.processed_at ?? "",
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return sha256(JSON.stringify(input));
}

export class WorkflowService implements InquiryProgressSink {
  private readonly queue = new FileMutationQueue();
  /** 每专题串行执行的在途 promise（避免并发触发重复预跑 / 抢跑同一 job）。 */
  private readonly inflight = new Map<string, Promise<void>>();
  private inquiryRunner?: Pick<AutoInquiryService, "run">;

  constructor(
    private readonly paths: DataPaths,
    private readonly audit: AuditService,
    private readonly cases: Pick<CaseService, "get" | "loadManifest">,
    private readonly registry: JobRegistry,
    private readonly elements: Pick<ElementService, "extract">,
    private readonly contradictions: Pick<ContradictionService, "detect">,
    /** 文本 LLM 是否已配置（未配置则自动分析降级跳过，不产生失败步骤，人工路径仍可用）。 */
    private readonly modelConfigured: boolean,
  ) {}

  /** 注入自动研判执行体（打破 WorkflowService ⇄ AutoInquiryService 构造环，见 app.ts）。 */
  setInquiryRunner(runner: Pick<AutoInquiryService, "run">): void {
    this.inquiryRunner = runner;
  }

  /**
   * 读状态并对账：status 为 running 但 JobRegistry 无对应活 job 的步骤（进程重启中断）改为
   * failed。文件不存在返回 null；损坏/旧格式由 readWorkflowState 抛错。
   */
  async load(caseId: string): Promise<WorkflowState | null> {
    const file = this.paths.workflowFile(caseId);
    return this.queue.runExclusive(file, async () => {
      const state = await readWorkflowState(file);
      if (!state) return null;
      if (this.reconcileRunning(caseId, state)) await this.write(file, state);
      return state;
    });
  }

  /**
   * 素材状态转换收口处调用（MaterialService 钩子）。仅当专题全部素材达终态（done/failed 且至少
   * 一件 done）且 autopilot 未关时推进。每专题串行、幂等。
   */
  onMaterialsSettled(actor: Identity, caseId: string): Promise<void> {
    const prev = this.inflight.get(caseId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.drive(actor, caseId));
    this.inflight.set(caseId, next);
    void next.finally(() => {
      if (this.inflight.get(caseId) === next) this.inflight.delete(caseId);
    });
    return next;
  }

  /** 等待某专题当前在途的自动推进结束（测试 / 收尾用）。 */
  async idle(caseId: string): Promise<void> {
    await (this.inflight.get(caseId) ?? Promise.resolve());
  }

  /**
   * 手动经 routes/jobs 起一个执行体：标记对应步骤 running 并在结束时回写终态。JobRegistry 按
   * (caseId,kind) 去重——已在运行则直接返回，天然防自动/手动并发同一步骤。
   */
  async startJob(actor: Identity, caseId: string, kind: JobKind): Promise<Job> {
    const existing = this.registry.status(caseId, kind);
    if (existing?.state === "running") return existing;
    await this.markStepRunning(caseId, kind);
    const job = this.registry.start<unknown>(caseId, kind, (ctx) => this.runBody(kind, actor, caseId, ctx));
    const settled = this.registry.settled(caseId, kind) ?? Promise.resolve(job);
    void settled
      .then((s) => this.finishStep(caseId, kind, s))
      .catch((e) => console.error(`[workflow] 步骤回写失败 ${caseId}/${kind}`, e));
    return job;
  }

  /**
   * 确认人工检查点：要求对应步骤 succeeded 且产物文件存在；artifactHash = sha256(产物原始字节)，
   * 产物重新生成后哈希不匹配即自动失效（见 clearStaleCheckpoint）。权限沿用专题写权限约定。
   */
  async confirmCheckpoint(actor: Identity, caseId: string, key: CheckpointKey): Promise<WorkflowState> {
    const manifest = await this.cases.get(actor, caseId);
    if (actor.role !== "admin" && actor.id !== manifest.owner) {
      await this.auditCheckpointDeny(actor, caseId, key, "not-owner");
      throw new AppError(403, "仅创建者或管理员可确认检查点");
    }
    const { kind, artifact } = CHECKPOINT_ARTIFACT[key];
    const file = this.paths.workflowFile(caseId);
    type Outcome = { ok: true; state: WorkflowState } | { ok: false; reason: string; err: AppError };
    const outcome = await this.queue.runExclusive<Outcome>(file, async () => {
      const s = await readWorkflowState(file);
      if (!s) return { ok: false, reason: "no-workflow", err: new AppError(409, "工作流尚未开始") };
      if (s.steps[STEP_BY_KIND[kind]].status !== "succeeded") {
        return { ok: false, reason: "step-not-succeeded", err: new AppError(409, "对应步骤尚未成功完成，无法确认") };
      }
      const hash = await this.artifactHash(caseId, artifact);
      if (hash === null) return { ok: false, reason: "artifact-missing", err: new AppError(409, "检查点产物文件缺失") };
      s.checkpoints[key] = { artifactHash: hash, approvedBy: actor.id, approvedAt: new Date().toISOString() };
      await this.write(file, s);
      return { ok: true, state: s };
    });
    if (!outcome.ok) {
      await this.auditCheckpointDeny(actor, caseId, key, outcome.reason);
      throw outcome.err;
    }
    await this.audit.append({
      user: actor.id,
      action: "workflow.checkpoint.confirm",
      object: `case:${caseId}`,
      caseId,
      detail: { caseId, key },
    });
    return outcome.state;
  }

  /** 逐题进度回写（AutoInquiryService 经此写 steps.inquiries.items，本服务为唯一写者）。 */
  async setInquiryItems(caseId: string, items: InquiryBatchItem[]): Promise<void> {
    const file = this.paths.workflowFile(caseId);
    await this.queue.runExclusive(file, async () => {
      const state = await readWorkflowState(file);
      if (!state) return; // 不应发生：runStep 先 markStepRunning 建档
      state.steps.inquiries.items = items;
      await this.write(file, state);
    });
  }

  // ---- 内部 ----

  private async drive(actor: Identity, caseId: string): Promise<void> {
    const manifest = await this.cases.loadManifest(caseId);
    if (!manifest || manifest.autopilot === false) return;
    const materials = manifest.materials;
    if (materials.length === 0) return;
    if (!materials.every((m) => m.status === "done" || m.status === "failed")) return;
    if (!materials.some((m) => m.status === "done")) return;

    // 模型未配置 → 自动分析降级跳过（不建失败步骤；人工路径不受影响）。
    if (!this.modelConfigured) {
      await this.auditSystem("workflow.skip", caseId, actor, "deny", { reason: "model-unavailable" });
      return;
    }

    const inputHash = materialInputHash(materials);
    await this.ensureFingerprint(caseId, inputHash); // 指纹变化 → 全部步骤 idle、检查点清空

    for (const stage of PIPELINE) {
      // 运行中可停：每步前重查开关（用户可中途关闭）。
      const current = await this.cases.loadManifest(caseId);
      if (!current || current.autopilot === false) {
        await this.auditSystem("workflow.stop", caseId, actor, "ok", { kind: stage.kind, reason: "disabled" });
        return;
      }
      const state = await readWorkflowState(this.paths.workflowFile(caseId));
      const step = state?.steps[STEP_BY_KIND[stage.kind]];
      const artifactOk = stage.artifact === null ? true : await this.artifactExists(caseId, stage.artifact);
      // 幂等：步骤 succeeded 且指纹匹配且产物在盘 → 跳过（沿用 autopilot 幂等语义）。
      if (step?.status === "succeeded" && state?.inputHash === inputHash && artifactOk) continue;

      const settled = await this.runStep(actor, caseId, stage.kind);
      if (settled.state === "cancelled") {
        await this.auditSystem("workflow.stop", caseId, actor, "ok", { kind: stage.kind, reason: "cancelled" });
        return;
      }
      if (settled.state === "error") {
        // 执行体失败：finishStep 已标记该步骤 failed；不级联，随后停止。
        await this.auditSystem("workflow.fail", caseId, actor, "error", { kind: stage.kind, reason: settled.error });
        return;
      }
      await this.auditSystem("workflow.advance", caseId, actor, "ok", { kind: stage.kind, jobId: settled.id });
    }
  }

  /** 顺序执行一个步骤并回写终态（onMaterialsSettled 用；等待 job 结束）。 */
  private async runStep(actor: Identity, caseId: string, kind: JobKind): Promise<Job> {
    await this.markStepRunning(caseId, kind);
    const job = this.registry.start<unknown>(caseId, kind, (ctx) => this.runBody(kind, actor, caseId, ctx));
    const settled = await (this.registry.settled(caseId, kind) ?? Promise.resolve(job));
    await this.finishStep(caseId, kind, settled);
    return settled;
  }

  private runBody(kind: JobKind, actor: Identity, caseId: string, ctx: JobContext): Promise<unknown> {
    const onProgress = (p: { done: number; total: number }) => ctx.setProgress({ phase: kind, done: p.done, total: p.total });
    if (kind === "elements") return this.elements.extract(actor, caseId, { signal: ctx.signal, onProgress });
    if (kind === "contradictions") return this.contradictions.detect(actor, caseId, { signal: ctx.signal, onProgress });
    if (!this.inquiryRunner) throw new Error("自动研判执行体未注入（setInquiryRunner）");
    return this.inquiryRunner.run(actor, caseId, ctx);
  }

  private async markStepRunning(caseId: string, kind: JobKind): Promise<void> {
    const file = this.paths.workflowFile(caseId);
    await this.queue.runExclusive(file, async () => {
      const state = (await readWorkflowState(file)) ?? freshState(await this.currentInputHash(caseId));
      const step = state.steps[STEP_BY_KIND[kind]];
      step.status = "running";
      step.startedAt = new Date().toISOString();
      delete step.finishedAt;
      delete step.error;
      await this.write(file, state);
    });
  }

  private async finishStep(caseId: string, kind: JobKind, job: Job): Promise<void> {
    const file = this.paths.workflowFile(caseId);
    await this.queue.runExclusive(file, async () => {
      const state = await readWorkflowState(file);
      if (!state) return;
      const step = state.steps[STEP_BY_KIND[kind]];
      step.finishedAt = new Date().toISOString();
      if (job.state === "done") {
        step.status = "succeeded";
        delete step.error;
        // 产物重新生成成功后自动清除失配的 checkpoint。
        await this.clearStaleCheckpoint(caseId, state, kind);
      } else if (job.state === "cancelled") {
        step.status = "cancelled";
      } else {
        step.status = "failed";
        step.error = job.error ?? "执行失败";
      }
      await this.write(file, state);
    });
  }

  /** 指纹变化或缺档时以当前指纹重建（全部步骤 idle、检查点清空）。 */
  private async ensureFingerprint(caseId: string, inputHash: string): Promise<void> {
    const file = this.paths.workflowFile(caseId);
    await this.queue.runExclusive(file, async () => {
      const state = await readWorkflowState(file);
      if (!state || state.inputHash !== inputHash) await this.write(file, freshState(inputHash));
    });
  }

  private reconcileRunning(caseId: string, state: WorkflowState): boolean {
    let changed = false;
    for (const stepKey of ["elements", "contradictions", "inquiries"] as StepKey[]) {
      const step: WorkflowStep = state.steps[stepKey];
      if (step.status === "running" && this.registry.status(caseId, KIND_BY_STEP[stepKey])?.state !== "running") {
        step.status = "failed";
        step.error = "服务重启中断，可重跑";
        step.finishedAt = new Date().toISOString();
        changed = true;
      }
    }
    return changed;
  }

  private async clearStaleCheckpoint(caseId: string, state: WorkflowState, kind: JobKind): Promise<void> {
    const key = kind === "elements" ? "entities" : kind === "contradictions" ? "contradictions" : null;
    if (!key) return;
    const approval = state.checkpoints[key];
    if (!approval) return;
    const hash = await this.artifactHash(caseId, CHECKPOINT_ARTIFACT[key].artifact);
    if (hash === null || hash !== approval.artifactHash) delete state.checkpoints[key];
  }

  private async currentInputHash(caseId: string): Promise<string> {
    const manifest = await this.cases.loadManifest(caseId);
    return manifest ? materialInputHash(manifest.materials) : "";
  }

  private async artifactHash(caseId: string, file: string): Promise<string | null> {
    try {
      return sha256Bytes(await readFile(path.join(this.paths.caseDir(caseId), file)));
    } catch {
      return null;
    }
  }

  private async artifactExists(caseId: string, file: string): Promise<boolean> {
    try {
      await access(path.join(this.paths.caseDir(caseId), file));
      return true;
    } catch {
      return false;
    }
  }

  private async write(file: string, state: WorkflowState): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
  }

  /** 拒绝路径审计：写失败则 console.error（调用方随后仍抛原始业务错误，绝不静默吞；R1 约定）。 */
  private async auditCheckpointDeny(actor: Identity, caseId: string, key: CheckpointKey, reason: string): Promise<void> {
    try {
      await this.audit.append({
        user: actor.id,
        action: "workflow.checkpoint.confirm",
        object: `case:${caseId}`,
        result: "deny",
        caseId,
        detail: { caseId, key, reason },
      });
    } catch (auditErr) {
      console.error(`[workflow] 审计写入失败 workflow.checkpoint.confirm case:${caseId}`, auditErr);
    }
  }

  private async auditSystem(action: string, caseId: string, actor: Identity, result: AuditResult, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.audit.append({ user: SYSTEM_ACTOR, action, object: `case:${caseId}`, result, caseId, detail: { caseId, triggeredBy: actor.id, ...detail } });
    } catch (auditErr) {
      console.error(`[workflow] 审计写入失败 ${action} case:${caseId}`, auditErr);
    }
  }
}
