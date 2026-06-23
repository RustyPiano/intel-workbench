import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_PROMPT_BODIES, type PromptStore } from "../admin/prompt-store.js";
import { mapWithConcurrency, splitIntoBatches } from "./batch-extract.js";
import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import { AppError } from "../domain/identity.js";
import type { Chunk, Citation, Contradiction, ContradictionAcknowledgement, ContradictionAcknowledgementStatus, Identity } from "../domain/types.js";
import { readContradictionAcknowledgements, saveContradictionAcknowledgement } from "../finding/finding-store.js";
import { chunkToCitation, resolveValidCitations } from "../inquiry/citation.js";
import { generateJson, type LlmDeps } from "../model/structured.js";
import type { MaterialService } from "../materials/material-service.js";
import { shortId } from "../util/hash.js";

const BATCH_CHUNKS = 40;
const CONCURRENCY = 4;
const MAX_PAIRS_PER_CLUSTER = 30;
const EXTRACT_PROMPT = DEFAULT_PROMPT_BODIES["contradiction-extract"];
const JUDGE_PROMPT = DEFAULT_PROMPT_BODIES["contradiction-judge"];

interface RawClaim {
  entity?: unknown;
  attribute?: unknown;
  value?: unknown;
  chunk_id?: unknown;
}

interface GroundedClaim {
  entity: string;
  attribute: string;
  value: string;
  chunk_id: string;
  material_id: string;
  citation: Citation;
  text: string;
}

interface JudgeResult {
  relation: "contradiction" | "agreement" | "unrelated";
  rationale: string;
  certainty?: number;
}

interface DetectionStats {
  clusters: number;
  pairsJudged: number;
  batches: number;
  chunksCovered: number;
  chunksTotal: number;
  failedBatches: number;
}

export type ContradictionDetectionStatus = "succeeded" | "degraded" | "failed";

export interface ContradictionDetectionResult {
  status: ContradictionDetectionStatus;
  contradictions: Contradiction[];
  processedChunks: number;
  totalChunks: number;
  truncated: boolean;
  warnings: string[];
  error?: string;
  acknowledgements?: ContradictionAcknowledgement[];
}

export class ContradictionDetectionError extends AppError {
  constructor(status: number, message: string, public readonly result: ContradictionDetectionResult) {
    super(status, message);
    this.name = "ContradictionDetectionError";
  }
}

interface DetectOptions {
  signal?: AbortSignal;
  onProgress?: (p: { done: number; total: number }) => void;
}

export interface AcknowledgeContradictionInput {
  status?: ContradictionAcknowledgementStatus;
  note?: string;
}

interface ClaimBatchResult {
  claims: GroundedClaim[];
  chunksCovered: number;
  failed: boolean;
}

// 按实体聚类（不含 attribute）：同一实体的不同属性表述（如 572号护卫舰 的 "状态"/"部署能力"/"动力测试状态"）
// 进同一簇，由簇内 NLI 判定是否真冲突。规避"按 entity:attribute 精确串聚类"对 LLM 自由抽取的表层差异过敏导致漏判
// （实测 entity:attribute 聚类几乎全是 size-1 簇 → recall≈0.17 且高方差）。entity 串（代号/舷号/编号）比 attribute 稳定。
function normalizeKey(entity: string): string {
  return entity.toLowerCase().replace(/\s+/g, "").trim();
}

function citationKey(citation: Citation): string {
  return `${citation.material_id}:${citation.content_hash}:${citation.snippet}`;
}

function claimText(claim: Pick<GroundedClaim, "entity" | "attribute" | "value">): string {
  return `${claim.entity} ${claim.attribute}: ${claim.value}`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function parseNumeric(value: string): number | null {
  const normalized = value.trim().replace(/,/g, "");
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function numericDistanceBonus(a: string, b: string): number {
  const left = parseNumeric(a);
  const right = parseNumeric(b);
  if (left === null || right === null || left === right) return 0;
  return 0.2 * Math.min(1, Math.abs(left - right) / Math.max(Math.abs(left), Math.abs(right), 1));
}

function asJudgeResult(raw: Record<string, unknown>): JudgeResult {
  const relation = raw.relation === "contradiction" || raw.relation === "agreement" || raw.relation === "unrelated"
    ? raw.relation
    : "unrelated";
  const certainty = typeof raw.certainty === "number" && Number.isFinite(raw.certainty) ? clamp01(raw.certainty) : undefined;
  return {
    relation,
    rationale: typeof raw.rationale === "string" ? raw.rationale : "",
    certainty,
  };
}

export class ContradictionService {
  private readonly detectionStats = new WeakMap<Contradiction[], DetectionStats>();

  constructor(
    private readonly paths: DataPaths,
    private readonly audit: AuditService,
    private readonly cases: CaseService,
    private readonly materials: MaterialService,
    private readonly llm: LlmDeps,
    private readonly promptStore?: PromptStore,
  ) {}

  async detect(actor: Identity, caseId: string, opts: DetectOptions = {}): Promise<ContradictionDetectionResult> {
    let totalChunks = 0;
    let canPersistFailure = false;
    try {
      const manifest = await this.cases.get(actor, caseId);
      canPersistFailure = true;
      const nameById = new Map(manifest.materials.map((m) => [m.id, m.filename]));
      const all = await this.materials.loadCaseChunks(caseId);
      totalChunks = all.length;
      if (all.length === 0) {
        const result = this.makeResult([], {
          clusters: 0,
          pairsJudged: 0,
          batches: 0,
          chunksCovered: 0,
          chunksTotal: 0,
          failedBatches: 0,
        });
        await this.persist(caseId, result);
        await this.audit.append({
          user: actor.id,
          action: "contradiction.detect",
          object: `case:${caseId}`,
          caseId,
          detail: { caseId, count: 0, clusters: 0, pairsJudged: 0, chunksCovered: 0, chunksTotal: 0, failedBatches: 0, status: result.status, truncated: result.truncated, reason: "无已加工素材" },
        });
        return result;
      }
      const contradictions = await this.detectFromChunks(actor, all, nameById, opts);
      const stats = this.detectionStats.get(contradictions) ?? {
        clusters: 0,
        pairsJudged: 0,
        batches: 0,
        chunksCovered: 0,
        chunksTotal: all.length,
        failedBatches: 0,
      };
      const result = this.makeResult(contradictions, stats);
      await this.persist(caseId, result);
      await this.audit.append({
        user: actor.id,
        action: "contradiction.detect",
        object: `case:${caseId}`,
        caseId,
        detail: {
          caseId,
          count: contradictions.length,
          clusters: stats.clusters,
          pairsJudged: stats.pairsJudged,
          batches: stats.batches,
          chunksCovered: stats.chunksCovered,
          chunksTotal: stats.chunksTotal,
          failedBatches: stats.failedBatches,
          status: result.status,
          truncated: result.truncated,
        },
      });
      return result;
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      const message = e instanceof Error ? e.message : String(e);
      const result = this.makeFailedResult(totalChunks, message);
      if (canPersistFailure) await this.persist(caseId, result);
      await this.audit.append({
        user: actor.id,
        action: "contradiction.detect",
        object: `case:${caseId}`,
        result: "error",
        caseId,
        detail: { result: "error", error: message },
      });
      // 失败（含 OfflineGuard 出站拒绝）必须显式抛出 → 任务落「error」态而非「done+空」，
      // 否则会把"被拒/出错"误呈为"未发现矛盾"（与 element.extract 一致：失败即失败）。
      throw new ContradictionDetectionError(e instanceof AppError ? e.status : 500, message, result);
    }
  }

  async detectFromChunks(actor: Identity, chunks: Chunk[], nameById: Map<string, string>, opts: DetectOptions = {}): Promise<Contradiction[]> {
    if (chunks.length === 0) {
      const contradictions: Contradiction[] = [];
      this.detectionStats.set(contradictions, { clusters: 0, pairsJudged: 0, batches: 0, chunksCovered: 0, chunksTotal: 0, failedBatches: 0 });
      return contradictions;
    }
    if (!this.llm.adapter || !this.llm.modelEndpoint) throw new Error("文本 LLM 未配置：矛盾检测不可用");

    const batches = splitIntoBatches(chunks, BATCH_CHUNKS);
    const batchResults = await mapWithConcurrency(batches, async (batch): Promise<ClaimBatchResult> => {
      // 零外发红线：每批出站前先授权——授权失败必须显式失败，不得当作"失败批次"吞掉。
      await this.llm.guard.authorize(this.llm.modelEndpoint, { user: actor.id, purpose: "contradiction-extract" });
      let rawClaims: RawClaim[];
      try {
        rawClaims = await this.extractClaims(batch, opts.signal);
      } catch (e) {
        if (opts.signal?.aborted || e instanceof AppError) throw e;
        // 仅模型/网络/解析失败 → best-effort 跳过该批，其余继续。
        return { claims: [], chunksCovered: 0, failed: true };
      }
      // 接地在 catch 之外：其内部缺陷应当显式抛出，而非被静默记成失败批次。
      const retrievedById = new Map(batch.map((chunk) => [chunk.chunk_id, chunk]));
      return { claims: this.groundClaims(rawClaims, retrievedById, nameById), chunksCovered: batch.length, failed: false };
    }, {
      concurrency: CONCURRENCY,
      signal: opts.signal,
      onSettled: (done, total) => opts.onProgress?.({ done, total }),
    });
    const claims = batchResults.flatMap((result) => result.claims);
    const chunksCovered = batchResults.reduce((sum, result) => sum + result.chunksCovered, 0);
    const failedBatches = batchResults.filter((result) => result.failed).length;
    const clusters = this.clusterClaims(claims);
    if (process.env.MINI_AGENT_CONTRADICTION_DEBUG) {
      console.error(`[ct-debug] grounded=${claims.length} clusters=${clusters.size} sizes=[${[...clusters.values()].map((c) => c.length).join(",")}] keys=${[...clusters.keys()].slice(0, 20).join(" | ")}`);
    }
    const { contradictions, pairsJudged } = await this.judgeClusters(actor, clusters, opts.signal);

    contradictions.sort((a, b) => b.confidence - a.confidence);
    this.detectionStats.set(contradictions, {
      clusters: clusters.size,
      pairsJudged,
      batches: batches.length,
      chunksCovered,
      chunksTotal: chunks.length,
      failedBatches,
    });
    return contradictions;
  }

  async get(actor: Identity, caseId: string): Promise<Contradiction[]> {
    await this.cases.get(actor, caseId);
    try {
      return JSON.parse(await readFile(this.contradictionsFile(caseId), "utf8")) as Contradiction[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  async getResult(actor: Identity, caseId: string): Promise<ContradictionDetectionResult> {
    await this.cases.get(actor, caseId);
    let result: ContradictionDetectionResult;
    try {
      result = JSON.parse(await readFile(this.contradictionsResultFile(caseId), "utf8")) as ContradictionDetectionResult;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const contradictions = await this.get(actor, caseId);
      result = this.makeResult(contradictions, {
        clusters: 0,
        pairsJudged: 0,
        batches: 0,
        chunksCovered: 0,
        chunksTotal: 0,
        failedBatches: 0,
      });
    }
    return { ...result, acknowledgements: await readContradictionAcknowledgements(this.paths, caseId) };
  }

  async acknowledge(actor: Identity, caseId: string, contradictionId: string, input: AcknowledgeContradictionInput): Promise<ContradictionAcknowledgement> {
    await this.cases.get(actor, caseId);
    if (actor.role !== "security" && actor.role !== "admin") {
      await this.auditContradictionAckDeny(actor, caseId, contradictionId, "role");
      throw new AppError(403, "仅保密员或管理员可处理矛盾状态");
    }
    const status = input.status;
    if (!isAcknowledgementStatus(status)) {
      await this.auditContradictionAckDeny(actor, caseId, contradictionId, "invalid-status");
      throw new AppError(400, "非法矛盾处理状态");
    }
    const result = await this.getResult(actor, caseId);
    if (!result.contradictions.some((contradiction) => contradiction.id === contradictionId)) {
      await this.auditContradictionAckDeny(actor, caseId, contradictionId, "not-found");
      throw new AppError(404, "矛盾记录不存在");
    }
    const existing = result.acknowledgements?.find((ack) => ack.contradiction_id === contradictionId);
    const acknowledgement: ContradictionAcknowledgement = {
      id: existing?.id ?? shortId("ca-"),
      case_id: caseId,
      contradiction_id: contradictionId,
      status,
      note: (input.note ?? "").trim(),
      by: actor.id,
      at: new Date().toISOString(),
    };
    await saveContradictionAcknowledgement(this.paths, acknowledgement);
    await this.audit.append({
      user: actor.id,
      action: "contradiction.acknowledge",
      object: `contradiction:${contradictionId}`,
      caseId,
      detail: { caseId, contradictionId, status, note: acknowledgement.note },
    });
    return acknowledgement;
  }

  private async extractClaims(chunks: Chunk[], signal?: AbortSignal): Promise<RawClaim[]> {
    const context = chunks.map((chunk) => `[${chunk.chunk_id}] ${chunk.text}`).join("\n\n");
    const systemPrompt = this.promptStore ? await this.promptStore.getBody("contradiction-extract") : EXTRACT_PROMPT;
    // claim 抽取属批量机械抽取：关思考求速度/规模。授权由调用方按批完成（见 detectFromChunks）。
    const raw = await generateJson(this.llm.adapter!, systemPrompt, `素材片段：\n${context}\n\n请只输出 JSON。`, { maxTokens: 2500, thinking: "disabled", signal });
    return Array.isArray(raw.claims) ? (raw.claims as RawClaim[]) : [];
  }

  private groundClaims(rawClaims: RawClaim[], retrievedById: Map<string, Chunk>, nameById: Map<string, string>): GroundedClaim[] {
    const chunkIds = rawClaims.map((claim) => claim.chunk_id).filter((id): id is string => typeof id === "string");
    const validKeys = new Set(resolveValidCitations(chunkIds, retrievedById, nameById).map(citationKey));
    const grounded: GroundedClaim[] = [];
    for (const raw of rawClaims) {
      const entity = typeof raw.entity === "string" ? raw.entity.trim() : "";
      const attribute = typeof raw.attribute === "string" ? raw.attribute.trim() : "";
      const value = typeof raw.value === "string" ? raw.value.trim() : "";
      const chunkId = typeof raw.chunk_id === "string" ? raw.chunk_id : "";
      if (!entity || !attribute || !value || !chunkId) continue;
      const chunk = retrievedById.get(chunkId);
      if (!chunk) continue;
      const citation = chunkToCitation(chunk, nameById.get(chunk.material_id) ?? chunk.material_id);
      if (!validKeys.has(citationKey(citation))) continue;
      grounded.push({
        entity,
        attribute,
        value,
        chunk_id: chunkId,
        material_id: chunk.material_id,
        citation,
        text: claimText({ entity, attribute, value }),
      });
    }
    return grounded;
  }

  private clusterClaims(claims: GroundedClaim[]): Map<string, GroundedClaim[]> {
    const clusters = new Map<string, GroundedClaim[]>();
    for (const claim of claims) {
      const key = normalizeKey(claim.entity);
      clusters.set(key, [...(clusters.get(key) ?? []), claim]);
    }
    return clusters;
  }

  private async judgeClusters(actor: Identity, clusters: Map<string, GroundedClaim[]>, signal?: AbortSignal): Promise<{ contradictions: Contradiction[]; pairsJudged: number }> {
    const contradictions: Contradiction[] = [];
    let pairsJudged = 0;
    for (const claims of clusters.values()) {
      let pairs = this.enumeratePairs(claims);
      if (pairs.length > MAX_PAIRS_PER_CLUSTER) {
        console.warn(`ContradictionService capped cluster pairs from ${pairs.length} to ${MAX_PAIRS_PER_CLUSTER}`);
        pairs = pairs.slice(0, MAX_PAIRS_PER_CLUSTER);
      }
      for (const [claimA, claimB] of pairs) {
        // 取消须贯穿判定阶段：批间检查中止信号，及时停掉后续成对 NLI 出站。
        if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        const judge = await this.judgePair(actor, claimA, claimB, signal);
        pairsJudged++;
        if (judge.relation !== "contradiction") continue;
        const crossSource = claimA.material_id !== claimB.material_id;
        contradictions.push({
          id: shortId("ct-"),
          entity: claimA.entity,
          attribute: claimA.attribute,
          scope: crossSource ? "cross-material" : "intra-material",
          claim_a: { text: claimA.text, citation: claimA.citation },
          claim_b: { text: claimB.text, citation: claimB.citation },
          relation: "contradiction",
          rationale: judge.rationale,
          confidence: this.confidence(judge.certainty, crossSource, claimA.value, claimB.value),
        });
      }
    }
    return { contradictions, pairsJudged };
  }

  private enumeratePairs(claims: GroundedClaim[]): [GroundedClaim, GroundedClaim][] {
    const pairs: [GroundedClaim, GroundedClaim][] = [];
    for (let i = 0; i < claims.length; i++) {
      for (let j = i + 1; j < claims.length; j++) {
        pairs.push([claims[i]!, claims[j]!]);
      }
    }
    return pairs;
  }

  private async judgePair(actor: Identity, claimA: GroundedClaim, claimB: GroundedClaim, signal?: AbortSignal): Promise<JudgeResult> {
    const systemPrompt = this.promptStore ? await this.promptStore.getBody("contradiction-judge") : JUDGE_PROMPT;
    await this.llm.guard.authorize(this.llm.modelEndpoint, { user: actor.id, purpose: "contradiction-judge" });
    const raw = await generateJson(
      this.llm.adapter!,
      systemPrompt,
      [
        `claim_a: ${claimA.text}`,
        `claim_b: ${claimB.text}`,
        "请只输出 JSON。",
      ].join("\n"),
      // 成对矛盾判定：benchmark 实测开思考反而降召回（F1 0.909 vs 关思考 0.957，见 benchmark-summary.md），
      // 故默认关思考（更快更省且更准）；env 置 "enabled" 可复跑对比。取消信号透传以中止在途判定。
      { maxTokens: 800, thinking: process.env.MINI_AGENT_CONTRADICTION_JUDGE_THINKING === "enabled" ? "enabled" : "disabled", signal },
    );
    return asJudgeResult(raw);
  }

  private confidence(certainty: number | undefined, crossSource: boolean, leftValue: string, rightValue: string): number {
    return clamp01(((certainty ?? 0.7) * 0.5) + (crossSource ? 0.3 : 0) + numericDistanceBonus(leftValue, rightValue));
  }

  private contradictionsFile(caseId: string): string {
    return path.join(this.paths.caseDir(caseId), "contradictions.json");
  }

  private contradictionsResultFile(caseId: string): string {
    return path.join(this.paths.caseDir(caseId), "contradictions.result.json");
  }

  private makeResult(contradictions: Contradiction[], stats: DetectionStats): ContradictionDetectionResult {
    const truncated = stats.chunksCovered < stats.chunksTotal;
    const warnings: string[] = [];
    if (stats.failedBatches > 0) warnings.push(`${stats.failedBatches} 个批次处理失败，结果为降级覆盖`);
    if (truncated && stats.failedBatches === 0) warnings.push(`仅覆盖 ${stats.chunksCovered}/${stats.chunksTotal} 个素材块`);
    return {
      status: warnings.length > 0 ? "degraded" : "succeeded",
      contradictions,
      processedChunks: stats.chunksCovered,
      totalChunks: stats.chunksTotal,
      truncated,
      warnings,
    };
  }

  private makeFailedResult(totalChunks: number, error: string): ContradictionDetectionResult {
    return {
      status: "failed",
      contradictions: [],
      processedChunks: 0,
      totalChunks,
      truncated: totalChunks > 0,
      warnings: [],
      error,
    };
  }

  private async persist(caseId: string, result: ContradictionDetectionResult): Promise<void> {
    const file = this.contradictionsFile(caseId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(result.contradictions, null, 2)}\n`, "utf8");
    await writeFile(this.contradictionsResultFile(caseId), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }

  private async auditContradictionAckDeny(actor: Identity, caseId: string, contradictionId: string, reason: string): Promise<void> {
    await this.audit.append({
      user: actor.id,
      action: "contradiction.acknowledge",
      object: `contradiction:${contradictionId}`,
      result: "deny",
      caseId,
      detail: { caseId, contradictionId, reason },
    });
  }
}

function isAcknowledgementStatus(value: unknown): value is ContradictionAcknowledgementStatus {
  return value === "open" || value === "resolved" || value === "dismissed";
}
