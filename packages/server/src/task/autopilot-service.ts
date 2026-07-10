import { access, readFile } from "node:fs/promises";
import path from "node:path";

import type { ContradictionService } from "../analysis/contradiction-service.js";
import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import type { AuditResult, Identity, Material } from "../domain/types.js";
import type { ElementService } from "../elements/element-service.js";
import type { AutoInquiryService } from "../inquiry/auto-inquiry-service.js";
import type { JobContext, JobRegistry } from "../jobs/job-registry.js";
import type { TaskService } from "./task-service.js";
import { writeFileAtomic } from "../util/atomic.js";
import { sha256 } from "../util/hash.js";

/**
 * 自动流水线（阶段三 M1·M3 / 计划 D2·D3·D6）。素材全部加工完成后，由素材服务在状态转换的
 * 收口处触发：自动创建/复用核验 TaskRun，并按流水线顺序预跑不需人工输入的执行体
 * （要素抽取 → 矛盾检测 → 自动研判），使「要素、矛盾、候选结论」在用户不点任何按钮时就绪；
 * checkpoint 阶段（实体归并、矛盾检测确认）仍由 TaskService.computeStages 停在人工确认处。
 *
 * 复用现有构件（D2·D3）：分析/研判经 JobRegistry.start 运行 → 现有 `/jobs/:kind/cancel` 即可停止，
 * 且与人工触发的同类 job 天然去重；阶段状态仍由 TaskService 从落盘产物派生，不另建系统。
 * 所有自动动作以 `system-autopilot` 落审计（D6）；创建/推进/失败均写事件。
 */

const SYSTEM_ACTOR = "system-autopilot";

interface AutopilotStep {
  stageKey: string;
  kind: "elements" | "contradictions" | "auto-inquiry";
  /** 产物已在盘上 → 幂等跳过（避免重复触发重跑、与人工复核抢跑）。 */
  artifact: string;
}

interface AutopilotState {
  inputHash: string;
  completed: AutopilotStep["kind"][];
}

/**
 * 预跑顺序即流水线中「不需人工输入」的执行体。矛盾检测在实体归并 checkpoint 之后、自动研判
 * 对应更靠后的「补充核验取证」阶段，但其执行体本身都不依赖 checkpoint 确认，故此处按序预跑以
 * 满足「矛盾/候选结论自动就绪」；阶段游标仍由 computeStages 停在第一个未确认 checkpoint
 * （详见 implementation-notes.md Deviations）。自动研判置于矛盾检测之后，使 suggestion 出题能
 * 用上已检出的矛盾（矛盾派生问题价值最高）。
 */
const STEPS: AutopilotStep[] = [
  { stageKey: "evidence-units", kind: "elements", artifact: "elements.json" },
  { stageKey: "contradiction-detection", kind: "contradictions", artifact: "contradictions.result.json" },
  { stageKey: "proposition-extraction", kind: "auto-inquiry", artifact: "auto-inquiry.json" },
];

export class AutopilotService {
  /** 每专题串行执行的在途 promise（避免并发触发重复建 run / 抢跑同一 job）。 */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly paths: DataPaths,
    private readonly audit: AuditService,
    private readonly cases: CaseService,
    private readonly tasks: TaskService,
    private readonly registry: JobRegistry,
    private readonly elements: Pick<ElementService, "extract">,
    private readonly contradictions: Pick<ContradictionService, "detect">,
    private readonly autoInquiry: Pick<AutoInquiryService, "run">,
    /** 文本 LLM 是否已配置（未配置则自动分析降级跳过，不产生失败 run，人工路径仍可用）。 */
    private readonly modelConfigured: boolean,
  ) {}

  /**
   * 素材状态转换收口处调用（MaterialService 钩子）。仅当专题全部素材达终态
   * （done/failed 且至少一件 done）且 autopilot 未关时才推进。每专题串行、幂等。
   */
  onMaterialsSettled(actor: Identity, caseId: string): Promise<void> {
    const prev = this.inflight.get(caseId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.run(actor, caseId));
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

  private async run(actor: Identity, caseId: string): Promise<void> {
    const manifest = await this.cases.loadManifest(caseId);
    if (!manifest || manifest.autopilot === false) return;
    const materials = manifest.materials;
    if (materials.length === 0) return;
    // 触发条件：全部素材达终态（processed / failed），且至少一件成功可供分析。
    if (!materials.every((m) => m.status === "done" || m.status === "failed")) return;
    if (!materials.some((m) => m.status === "done")) return;

    // 模型未配置 → 自动分析降级跳过（不建失败 run；人工路径不受影响）。
    if (!this.modelConfigured) {
      await this.auditSystem("autopilot.skip", caseId, actor, "deny", { reason: "model-unavailable" });
      return;
    }

    const inputHash = this.materialInputHash(materials);
    let state = await this.loadState(caseId);
    if (!state) {
      // 兼容升级前已有产物：首次见到时认领当前输入；之后所有素材变更都按指纹失效。
      const completed: AutopilotStep["kind"][] = [];
      for (const step of STEPS) if (await this.artifactExists(caseId, step.artifact)) completed.push(step.kind);
      state = { inputHash, completed };
      await this.saveState(caseId, state);
    } else if (state.inputHash !== inputHash) {
      state = { inputHash, completed: [] };
      await this.saveState(caseId, state);
    }

    let runId: string;
    try {
      const created = await this.tasks.createRun(actor, caseId);
      if (created.run.status !== "active") return; // 已终态运行不复用；下次触发再新建
      runId = created.run.id;
      if (created.created) {
        await this.auditSystem("autopilot.run.create", caseId, actor, "ok", { runId });
      }
    } catch (e) {
      await this.auditSystem("autopilot.fail", caseId, actor, "error", { phase: "create-run", reason: message(e) });
      return;
    }

    for (const step of STEPS) {
      // 运行中可停：每步前重查开关（用户可中途关闭）。
      const current = await this.cases.loadManifest(caseId);
      if (!current || current.autopilot === false) {
        await this.auditSystem("autopilot.stop", caseId, actor, "ok", { stage: step.stageKey, reason: "disabled" });
        return;
      }
      if (state.completed.includes(step.kind) && await this.artifactExists(caseId, step.artifact)) continue;

      const job = this.registry.start(caseId, step.kind, (ctx) => this.runBody(step.kind, actor, caseId, ctx));
      const settled = (await this.registry.settled(caseId, step.kind)) ?? job;

      if (settled.state === "done") {
        if (!state.completed.includes(step.kind)) state.completed.push(step.kind);
        await this.saveState(caseId, state);
        await this.auditSystem("autopilot.advance", caseId, actor, "ok", { stage: step.stageKey, kind: step.kind, jobId: settled.id });
        continue;
      }
      if (settled.state === "cancelled") {
        await this.auditSystem("autopilot.stop", caseId, actor, "ok", { stage: step.stageKey, kind: step.kind, reason: "cancelled" });
        return;
      }
      // 执行体失败：标记对应阶段 failed（仅当其为当前 active 阶段），不级联，随后停止。
      await this.auditSystem("autopilot.fail", caseId, actor, "error", { stage: step.stageKey, kind: step.kind, reason: settled.error });
      await this.failStageIfActive(actor, caseId, runId, step.stageKey);
      return;
    }
  }

  private runBody(kind: AutopilotStep["kind"], actor: Identity, caseId: string, ctx: JobContext): Promise<unknown> {
    const onProgress = (p: { done: number; total: number }) => ctx.setProgress({ phase: kind, done: p.done, total: p.total });
    if (kind === "elements") return this.elements.extract(actor, caseId, { signal: ctx.signal, onProgress });
    if (kind === "contradictions") return this.contradictions.detect(actor, caseId, { signal: ctx.signal, onProgress });
    // 自动研判批处理自行落盘进度并按 ctx.setProgress 汇报（题数），信号贯通到底层 agent。
    return this.autoInquiry.run(actor, caseId, ctx);
  }

  /**
   * 仅当阶段当前为 active 时标记 failed。矛盾检测阶段在未确认 checkpoint 之后被阻塞（pending），
   * 不能经 advanceStage 标记——其失败由落盘 `contradictions.result.json` 的 status=failed 派生承载。
   */
  private async failStageIfActive(actor: Identity, caseId: string, runId: string, stageKey: string): Promise<void> {
    try {
      const { run } = await this.tasks.getRun(actor, caseId, runId);
      const stage = run.stages.find((s) => s.key === stageKey);
      if (stage?.status === "active") {
        await this.tasks.advanceStage(actor, caseId, runId, stageKey, { status: "failed" });
      }
    } catch {
      // 尽力而为：失败已单独落审计；派生失败仍由落盘产物承载。
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

  private materialInputHash(materials: Material[]): string {
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

  private stateFile(caseId: string): string {
    return path.join(this.paths.caseDir(caseId), "autopilot-state.json");
  }

  private async loadState(caseId: string): Promise<AutopilotState | null> {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile(caseId), "utf8")) as AutopilotState;
      return typeof parsed.inputHash === "string" && Array.isArray(parsed.completed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async saveState(caseId: string, state: AutopilotState): Promise<void> {
    await writeFileAtomic(this.stateFile(caseId), `${JSON.stringify(state, null, 2)}\n`);
  }

  private async auditSystem(action: string, caseId: string, actor: Identity, result: AuditResult, detail: Record<string, unknown>): Promise<void> {
    await this.audit
      .append({ user: SYSTEM_ACTOR, action, object: `case:${caseId}`, result, caseId, detail: { caseId, triggeredBy: actor.id, ...detail } })
      .catch(() => undefined);
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
