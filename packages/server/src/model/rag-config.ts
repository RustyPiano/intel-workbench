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
