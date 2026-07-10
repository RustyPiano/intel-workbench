import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { AuditService } from "../audit/audit-service.js";
import type { DataPaths } from "../data/paths.js";
import type { AuditResult, Identity, Inquiry } from "../domain/types.js";
import type { JobContext } from "../jobs/job-registry.js";
import type { SuggestionService } from "../suggestion/suggestion-service.js";
import { writeFileAtomic } from "../util/atomic.js";
import type { InquiryService } from "./inquiry-service.js";

/**
 * 自动研判批处理（阶段三 M3 / 计划 D3）。复用既有构件，不新建产物类型：
 * suggestion 服务出题（优先 LLM，未配置回退规则）→ 逐题走与手动 POST /inquiries 完全相同的
 * agent 问答（`InquiryService.ask`）→ 每题产物照常持久化（inquiries.jsonl + 结构化候选），
 * 由既有「问答 claims → Finding 候选池」机制（SuggestionService.suggestFindings）入池。
 *
 * 顺序执行、默认每案上限 8 题（`MINI_AGENT_AUTO_INQUIRY_MAX` 可调）；AbortSignal 贯通到
 * 底层 agent（`ask` 的 signal 直达 conversation.send）；单题失败记录后继续下一题，不中断批次；
 * 取消中止整批。进度落盘 `cases/<id>/auto-inquiry.json` 供简报轮询（每请求现算，不进 brief 指纹）。
 *
 * 审计双轨（D6，与 M1 一致）：本服务的批处理事件（`auto-inquiry.*`）与底层 `inquiry.create`
 * 均以触发者真实身份记账（操作链）；作为流水线执行体被 AutopilotService 调用时，后者另以
 * `system-autopilot` 记 `autopilot.advance/fail`（决策链）。
 */

const DEFAULT_MAX = 8;
const MAX_ATTEMPTS = 3;

/** 每题状态：待跑 / 进行中 / 已产生候选 / 已完成（无候选）/ 失败。 */
export type AutoInquiryItemStatus = "pending" | "running" | "candidate" | "done" | "failed";

export interface AutoInquiryItem {
  question: string;
  status: AutoInquiryItemStatus;
  /** 该题产生的问答记录 id（成功跑完后填）。 */
  inquiryId?: string;
  /** 问答终态（answered / insufficient / error）。 */
  inquiryStatus?: Inquiry["status"];
  /** 该题产生的可入池候选数（结构化候选 + 达标的支持型结论）。 */
  candidateCount?: number;
  /** 失败原因（status=failed 时填）。 */
  error?: string;
  attempts?: number;
}

/** 批处理进度（落 `cases/<id>/auto-inquiry.json`）。 */
export interface AutoInquiryProgress {
  status: "running" | "done" | "cancelled" | "failed";
  total: number;
  completed: number;
  /** 当前进行中的题目下标；空闲时 null。 */
  currentIndex: number | null;
  items: AutoInquiryItem[];
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export class AutoInquiryBatchError extends Error {
  constructor(public readonly result: AutoInquiryProgress) {
    super("自动研判存在重试后仍失败的问题");
    this.name = "AutoInquiryBatchError";
  }
}

function readMax(): number {
  const raw = process.env.MINI_AGENT_AUTO_INQUIRY_MAX;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX;
}

/** 去重键：去首尾空白与结尾标点（与 suggestion-service 的归一化一致）。 */
function normalizeKey(question: string): string {
  return question.trim().replace(/[？?！!。.]+$/g, "");
}

/**
 * 该题可入池候选数（口径贴合 SuggestionService.suggestFindings 的来源零 / 来源一）：
 * 结构化候选须至少 1 条支持引用已判 supported；支持型结论须 supported 且 ≥2 条 supported 引用、
 * 无对立引用。仅用于「已产生候选」徽章，真正的证据校验与去重仍在 suggestFindings 落地。
 * 导出供 demo/seed.ts 复用，保证预置 auto-inquiry.json 的 candidateCount 与本服务口径不漂移。
 */
export function countCandidates(inquiry: Inquiry): number {
  let count = 0;
  for (const sf of inquiry.submitted_findings ?? []) {
    if (sf.supporting_citations.length > 0 && sf.supporting_citations.every((c) => c.support_status === "supported")) count += 1;
  }
  for (const claim of inquiry.claims) {
    if (claim.support_status !== "supported") continue;
    if (claim.citations.some((c) => c.support_status !== "supported" || c.support_label === "contradicts")) continue;
    if (claim.citations.filter((c) => c.support_status === "supported").length >= 2) count += 1;
  }
  return count;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class AutoInquiryService {
  constructor(
    private readonly paths: DataPaths,
    private readonly audit: AuditService,
    private readonly suggestions: Pick<SuggestionService, "suggestQuestionsWithLLM">,
    private readonly inquiries: Pick<InquiryService, "ask" | "list">,
  ) {}

  /** 读批处理进度（供简报现算叠加 / 轮询）。缺失或损坏返回 null。 */
  async getProgress(caseId: string): Promise<AutoInquiryProgress | null> {
    try {
      const parsed = JSON.parse(await readFile(this.file(caseId), "utf8")) as AutoInquiryProgress;
      return parsed && Array.isArray(parsed.items) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * 运行一批自动研判。作为 JobRegistry 的 `auto-inquiry` job 执行体 / AutopilotService 的第三个
   * 执行体调用。出题 → 逐题顺序问答 → 落盘进度。ctx.signal 取消即中止批次并标记 cancelled。
   */
  async run(actor: Identity, caseId: string, ctx: JobContext): Promise<AutoInquiryProgress> {
    const max = readMax();
    const [recommended, existing] = await Promise.all([
      this.suggestions.suggestQuestionsWithLLM(actor, caseId, { maxQuestions: max * 2 }),
      this.inquiries.list(actor, caseId),
    ]);
    // 去重 brief/问答已列出的相同问题（避免重复问答）；不做复杂消歧（D3）。
    const existingKeys = new Set(existing.map((i) => normalizeKey(i.question)));
    const seen = new Set<string>();
    const questions: string[] = [];
    for (const s of recommended) {
      if (s.category === "basic") continue; // 基础问题由要素抽取覆盖，不占批处理名额（与 generateFindingSuggestions 一致）
      const key = normalizeKey(s.question);
      if (!key || seen.has(key) || existingKeys.has(key)) continue;
      seen.add(key);
      questions.push(s.question.trim());
      if (questions.length >= max) break;
    }

    const now = (): string => new Date().toISOString();
    const progress: AutoInquiryProgress = {
      status: "running",
      total: questions.length,
      completed: 0,
      currentIndex: null,
      items: questions.map((question) => ({ question, status: "pending" as const })),
      startedAt: now(),
      updatedAt: now(),
    };
    await this.write(caseId, progress);
    ctx.setProgress({ phase: "auto-inquiry", done: 0, total: questions.length });
    await this.auditBatch(actor, caseId, "auto-inquiry.batch", "ok", { total: questions.length, max });

    for (let i = 0; i < questions.length; i++) {
      if (ctx.signal.aborted) {
        progress.status = "cancelled";
        break;
      }
      const item = progress.items[i]!;
      item.status = "running";
      progress.currentIndex = i;
      progress.updatedAt = now();
      await this.write(caseId, progress);

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        item.attempts = attempt;
        try {
          const inquiry = await this.inquiries.ask(actor, caseId, item.question, { deep: true, signal: ctx.signal });
          const candidates = countCandidates(inquiry);
          item.inquiryId = inquiry.id;
          item.inquiryStatus = inquiry.status;
          item.candidateCount = candidates;
          item.status = candidates > 0 ? "candidate" : "done";
          delete item.error;
          break;
        } catch (e) {
          // 取消导致的中断不判该题失败：还原为待跑，标记批次取消并停止后续题目。
          if (ctx.signal.aborted) {
            item.status = "pending";
            progress.status = "cancelled";
            progress.currentIndex = null;
            progress.updatedAt = now();
            await this.write(caseId, progress);
            break;
          }
          item.error = message(e);
          if (attempt < MAX_ATTEMPTS) {
            await this.auditBatch(actor, caseId, "auto-inquiry.question.retry", "error", { index: i, question: item.question, reason: item.error, attempt });
            continue;
          }
          item.status = "failed";
          await this.auditBatch(actor, caseId, "auto-inquiry.question", "error", { index: i, question: item.question, reason: item.error, attempts: attempt });
        }
      }

      if (progress.status === "cancelled") break;

      progress.completed += 1;
      progress.currentIndex = null;
      progress.updatedAt = now();
      ctx.setProgress({ phase: "auto-inquiry", done: progress.completed, total: questions.length });
      await this.write(caseId, progress);
    }

    if (progress.status === "running") progress.status = progress.items.some((item) => item.status === "failed") ? "failed" : "done";
    progress.currentIndex = null;
    progress.finishedAt = now();
    progress.updatedAt = now();
    await this.write(caseId, progress);
    await this.auditBatch(actor, caseId, "auto-inquiry.done", progress.status === "failed" ? "error" : "ok", {
      status: progress.status,
      total: progress.total,
      completed: progress.completed,
      candidates: progress.items.filter((it) => it.status === "candidate").length,
      failed: progress.items.filter((it) => it.status === "failed").length,
    });
    if (progress.status === "failed") throw new AutoInquiryBatchError(progress);
    return progress;
  }

  private file(caseId: string): string {
    return path.join(this.paths.caseDir(caseId), "auto-inquiry.json");
  }

  private async write(caseId: string, progress: AutoInquiryProgress): Promise<void> {
    const file = this.file(caseId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(progress, null, 2)}\n`);
  }

  private async auditBatch(actor: Identity, caseId: string, action: string, result: AuditResult, detail: Record<string, unknown>): Promise<void> {
    await this.audit
      .append({ user: actor.id, action, object: `case:${caseId}`, result, caseId, detail: { caseId, ...detail } })
      .catch(() => undefined);
  }
}
