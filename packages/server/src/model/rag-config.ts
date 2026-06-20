/**
 * RAG 检索配置（二期 §7）。token 预算 opt-in：未设 `MINI_AGENT_CTX_BUDGET_TOKENS`
 * 即退回一期 BM25 top-k（评审：部署模型未知前，过高的默认会在生产静默撑爆生成）。
 */

/** 读全上下文 token 预算；未配置/非法 → null（退检索路）。 */
export function readCtxBudgetTokens(): number | null {
  const raw = process.env.MINI_AGENT_CTX_BUDGET_TOKENS;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** 是否启用 Contextual Retrieval：默认关闭，避免未显式配置时新增 LLM 出站。 */
export function readContextualRetrieval(): boolean {
  return process.env.MINI_AGENT_CONTEXTUAL_RETRIEVAL === "true";
}

export type QueryRewriteMode = "off" | "rewrite" | "hyde";

export function readQueryRewriteMode(): QueryRewriteMode {
  const v = process.env.MINI_AGENT_QUERY_REWRITE;
  return v === "rewrite" || v === "hyde" ? v : "off";
}

/** 重排触发的最小候选数门控默认值（§5.2）。候选数 < 阈值不重排：小候选集精排无收益、徒增一次出站。 */
const RERANK_MIN_CANDIDATES = 8;

/**
 * 读重排门控阈值 `MINI_AGENT_RERANK_MIN_CANDIDATES`；未配置/非法 → 默认 8。
 * 注意：候选来自过取回深度（inquiry-service `RERANK_CANDIDATES`=24），故阈值设高于 24
 * 会使重排**永不触发**（候选数恒 ≤ 24）——关闭重排应改为不配置 reranker，而非调高此值。
 */
export function readRerankMinCandidates(): number {
  const raw = process.env.MINI_AGENT_RERANK_MIN_CANDIDATES;
  if (!raw) return RERANK_MIN_CANDIDATES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : RERANK_MIN_CANDIDATES;
}
