import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import { AppError } from "../domain/identity.js";
import type { Chunk, Identity, Inquiry, InquiryClaim } from "../domain/types.js";
import type { MaterialService } from "../materials/material-service.js";
import { readCtxBudgetTokens, readRerankMinCandidates } from "../model/rag-config.js";
import type { EmbeddingAdapter, RerankerAdapter } from "../model/slots.js";
import { generateJson, type LlmDeps } from "../model/structured.js";
import { shortId } from "../util/hash.js";
import { resolveValidCitations } from "./citation.js";
import { rerankTopK, retrieveHybrid, selectContext } from "./retrieval.js";

/** 稠密检索依赖（二期 P2.4）。embed 缺省 null → 检索退 BM25-only。 */
export interface DenseDeps {
  embed: EmbeddingAdapter | null;
  /** embed 端点（real 适配器出站前授权用；mock 在进程内为 ""，跳过授权）。 */
  embedEndpoint: string;
}

/** 重排依赖（二期 P2.5，可选门控）。reranker 缺省 null → 不重排，混合检索结果直用。 */
export interface RerankDeps {
  reranker: RerankerAdapter | null;
  /** rerank 端点（real 适配器出站前授权用；mock 在进程内为 ""，跳过授权）。 */
  rerankEndpoint: string;
}

/**
 * 问答带溯源（工程方案 §7.3）。受控管线，不走开放工具循环：
 * 检索 → （无命中即拒答）→ OfflineGuard 授权 → 结构化生成 → CitationService
 * 校验 → 落 `inquiries.jsonl`。诚实边界：绑定来源 ≠ 证明蕴含（§7.3 末），
 * 由人工复核兜底。
 */

const INSUFFICIENT = "现有材料不足以判断";
const TIMEOUT_MS = 60_000;
const TOP_K = 6;
/** 重排候选过取回深度（§5.2 二阶段）：启用重排时先取宽候选，再由 Reranker 精排回 TOP_K。 */
const RERANK_CANDIDATES = 24;

interface RawClaim {
  text?: unknown;
  type?: unknown;
  citations?: unknown;
}
interface RawOutput {
  claims?: RawClaim[];
  insufficient?: boolean;
}

export class InquiryService {
  constructor(
    private readonly paths: DataPaths,
    private readonly audit: AuditService,
    private readonly cases: CaseService,
    private readonly materials: MaterialService,
    private readonly deps: LlmDeps,
    /** 稠密检索依赖（二期 P2.4）；缺省无 embed → 检索退 BM25-only。 */
    private readonly dense: DenseDeps = { embed: null, embedEndpoint: "" },
    /** 重排依赖（二期 P2.5）；缺省无 reranker → 不重排，默认路径不变。 */
    private readonly rerank: RerankDeps = { reranker: null, rerankEndpoint: "" },
  ) {}

  async ask(actor: Identity, caseId: string, question: string): Promise<Inquiry> {
    const q = question?.trim();
    if (!q) throw new AppError(400, "问题不能为空");
    const manifest = await this.cases.get(actor, caseId); // 访问 + 密级校验
    const nameById = new Map(manifest.materials.map((m) => [m.id, m.filename]));

    const chunks = await this.materials.loadCaseChunks(caseId);
    // token 预算路由（§5.1）：预算内全上下文、超预算检索；未设预算退一期 top-k。
    const sel = selectContext(q, chunks, readCtxBudgetTokens(), TOP_K);
    let used = sel.used;
    let mode: string = sel.mode;
    let staleIndex = 0;
    // 检索路且 embed 可用 → 升级为 BM25 ⊕ dense 混合（§5.2）；否则保持 BM25。
    if (sel.mode === "retrieval" && this.dense.embed) {
      const hybrid = await this.hybridRetrieve(actor, q, caseId, chunks);
      used = hybrid.used;
      staleIndex = hybrid.stale;
      mode = hybrid.reranked ? "hybrid+rerank" : "hybrid";
    }

    let inquiry: Inquiry;
    if (chunks.length === 0) {
      // ① 专题无任何 chunk（全上下文下原 hits===0 判据改此，§5.1）。
      inquiry = this.make(actor, q, "insufficient", `${INSUFFICIENT}（专题暂无已加工素材）`, []);
    } else if (used.length === 0) {
      // 检索路无命中（全上下文下 used 必非空，此分支仅检索路触发）。
      inquiry = this.make(actor, q, "insufficient", `${INSUFFICIENT}（未检索到相关素材片段）`, []);
    } else {
      // ②③ 拒答（模型 insufficient / 全 claim 失效）仍在 generateAndValidate 内守红线。
      inquiry = await this.generateAndValidate(actor, q, used, nameById);
    }

    await this.persist(caseId, inquiry);
    await this.audit.append({
      user: actor.id,
      action: "inquiry.create",
      object: `inquiry:${inquiry.id}`,
      caseId,
      detail: { caseId, inquiryId: inquiry.id, status: inquiry.status, mode, used: used.length, staleIndex },
    });
    return inquiry;
  }

  /**
   * BM25 ⊕ dense 混合检索（§5.2）+ 可选重排二阶段（§5.2，P2.5）。
   * embed/rerank query 出站前授权（real）；向量缺失/维度不符自动退 BM25。
   * 重排门控：reranker 配置 且 融合候选数 ≥ 阈值才精排，否则直取融合 top-k（默认路径不变）。
   */
  private async hybridRetrieve(
    actor: Identity,
    q: string,
    caseId: string,
    chunks: Chunk[],
  ): Promise<{ used: Chunk[]; stale: number; reranked: boolean }> {
    const embed = this.dense.embed!;
    // 零外发红线：real embed 端点出站前授权（mock 在进程内、endpoint 为空则跳过）。
    if (this.dense.embedEndpoint) {
      await this.deps.guard.authorize(this.dense.embedEndpoint, { user: actor.id, purpose: "embed-query" });
    }
    const [queryVec] = await embed.embed([q]);
    const { byId, stale } = await this.materials.loadCaseVectors(caseId, embed);
    const reranker = this.rerank.reranker;
    if (!reranker) {
      // 重排关：融合 top-k 直用（默认路径，与 P2.4 一致）。
      return { used: retrieveHybrid(q, chunks, queryVec ?? null, byId, TOP_K), stale: stale.length, reranked: false };
    }
    // 重排开：取宽候选；候选数 < 阈值则跳过精排（门控），直取融合 top-k。
    const candidates = retrieveHybrid(q, chunks, queryVec ?? null, byId, RERANK_CANDIDATES);
    if (candidates.length < readRerankMinCandidates()) {
      return { used: candidates.slice(0, TOP_K), stale: stale.length, reranked: false };
    }
    // 零外发红线：real rerank 端点出站前授权（mock 在进程内、endpoint 为空则跳过）。
    if (this.rerank.rerankEndpoint) {
      await this.deps.guard.authorize(this.rerank.rerankEndpoint, { user: actor.id, purpose: "rerank-query" });
    }
    const used = await rerankTopK(q, candidates, reranker, TOP_K);
    return { used, stale: stale.length, reranked: true };
  }

  async list(actor: Identity, caseId: string): Promise<Inquiry[]> {
    await this.cases.get(actor, caseId); // 访问校验
    try {
      const raw = await readFile(this.inquiriesFile(caseId), "utf8");
      return raw
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Inquiry);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  private async generateAndValidate(
    actor: Identity,
    question: string,
    retrieved: Chunk[],
    nameById: Map<string, string>,
  ): Promise<Inquiry> {
    if (!this.deps.adapter || !this.deps.modelEndpoint) {
      throw new AppError(503, "文本 LLM 未配置：请设置 MINI_AGENT_MODEL / MINI_AGENT_API_KEY / MINI_AGENT_BASE_URL");
    }
    // 零外发红线：出站前先经 OfflineGuard 授权（放行/拒绝均落审计，§7.1）。
    await this.deps.guard.authorize(this.deps.modelEndpoint, { user: actor.id, purpose: "text-llm-inquiry" });

    let raw: RawOutput;
    try {
      raw = await this.callModel(question, retrieved);
    } catch (e) {
      return this.make(actor, question, "error", `模型调用失败，未生成结论（${(e as Error).message}）。请稍后重试。`, []);
    }

    if (raw.insufficient) {
      return this.make(actor, question, "insufficient", INSUFFICIENT, []);
    }
    const retrievedById = new Map(retrieved.map((c) => [c.chunk_id, c]));
    const claims = (Array.isArray(raw.claims) ? raw.claims : []).map((rc) => this.validateClaim(rc, retrievedById, nameById));
    const verified = claims.filter((c) => c.status === "verified");
    if (verified.length === 0) {
      // 全部结论无有效引用 → 拒答（§7.3 step 4），但保留待核结论供人工参考。
      return this.make(actor, question, "insufficient", INSUFFICIENT, claims);
    }
    const answer = verified.map((c, i) => `${i + 1}. ${c.text}`).join("\n");
    return this.make(actor, question, "answered", answer, claims);
  }

  /** CitationService 校验（§7.3 step 4）：每条引用须命中检索集且 content_hash 一致。 */
  private validateClaim(rc: RawClaim, retrievedById: Map<string, Chunk>, nameById: Map<string, string>): InquiryClaim {
    const type = rc.type === "inference" ? "inference" : "fact";
    const ids = Array.isArray(rc.citations) ? rc.citations.filter((x): x is string => typeof x === "string") : [];
    const citations = resolveValidCitations(ids, retrievedById, nameById);
    // 结论须被完全支撑：所有引用都有效且至少一条。
    const verified = ids.length > 0 && citations.length === ids.length;
    return {
      text: String(rc.text ?? "").trim(),
      type,
      status: verified ? "verified" : "unverified",
      citations,
    };
  }

  private async callModel(question: string, retrieved: Chunk[]): Promise<RawOutput> {
    const context = retrieved.map((c) => `[${c.chunk_id}] ${c.text}`).join("\n\n");
    const systemPrompt = [
      "你是情报分析助手。只能依据下方带编号的素材片段回答，不得使用片段之外的任何知识或常识。",
      "每条结论必须在 citations 中引用支撑它的片段编号（chunk_id）。",
      "若给定片段不足以支撑任何结论，置 insufficient=true。",
      "只输出 JSON，不要任何额外文字。schema：",
      '{"claims":[{"text":"结论文本","type":"fact|inference","citations":["chunk_id"]}],"insufficient":false}',
    ].join("\n");
    const userContent = `素材片段：\n${context}\n\n问题：${question}\n\n请只输出 JSON。`;
    return (await generateJson(this.deps.adapter!, systemPrompt, userContent, { timeoutMs: TIMEOUT_MS })) as RawOutput;
  }

  private make(actor: Identity, question: string, status: Inquiry["status"], answer: string, claims: InquiryClaim[]): Inquiry {
    return { id: shortId("q-"), ts: new Date().toISOString(), user: actor.id, question, status, answer, claims };
  }

  private inquiriesFile(caseId: string): string {
    return path.join(this.paths.caseDir(caseId), "inquiries.jsonl");
  }

  private async persist(caseId: string, inquiry: Inquiry): Promise<void> {
    const file = this.inquiriesFile(caseId);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(inquiry)}\n`, "utf8");
  }
}
