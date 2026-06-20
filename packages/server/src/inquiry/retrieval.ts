import type { Chunk } from "../domain/types.js";
import type { RerankerAdapter } from "../model/slots.js";

/**
 * 一期检索：关键词/全文 BM25 兜底（工程方案 §7.3 step 2；嵌入检索二期）。
 *
 * 中英混排分词：拉丁词原样 + 中文字符 bigram + 单字，兼顾召回（无需依赖）。
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  for (const m of lower.matchAll(/[a-z0-9]+/g)) tokens.push(m[0]);
  const cjk = lower.match(/[一-鿿]/g) ?? [];
  for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk[i] + cjk[i + 1]);
  for (const c of cjk) tokens.push(c);
  return tokens;
}

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
}

export function indexText(chunk: Chunk): string {
  return chunk.context ? `${chunk.context}\n\n${chunk.text}` : chunk.text;
}

const K1 = 1.5;
const B = 0.75;

/** BM25 打分，返回得分 > 0 的 top-k chunk（按分降序）。 */
export function retrieve(query: string, chunks: Chunk[], k = 6): ScoredChunk[] {
  if (chunks.length === 0) return [];
  const docTokens = chunks.map((c) => tokenize(indexText(c)));
  const n = chunks.length;
  const df = new Map<string, number>();
  for (const toks of docTokens) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const avgdl = docTokens.reduce((sum, t) => sum + t.length, 0) / n;
  const queryTerms = [...new Set(tokenize(query))];

  const scored = chunks.map((chunk, i) => {
    const toks = docTokens[i];
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const dft = df.get(term) ?? 0;
      const f = tf.get(term) ?? 0;
      if (!dft || !f) continue;
      const idf = Math.log(1 + (n - dft + 0.5) / (dft + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * toks.length) / Math.max(avgdl, 1))));
    }
    return { chunk, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/**
 * Token 预算路由（二期 Spec §5.1）。小数据走全上下文（消除召回瓶颈），
 * 大数据才检索。估算 fail-safe：宁可保守也不撑爆真实窗口。
 */

/** 近边界即走检索（评审：低估→撑爆窗口属不对称风险，留 20% 安全垫）。 */
const BUDGET_SAFETY = 0.8;

/**
 * 粗估 token（Spec §5.1）：非 ASCII 字符保守计 1（CJK/全角/西里尔/希腊/重音拉丁——
 * 真实 BPE 多为每字 ≥1 token），ASCII（拉丁/数字/标点）≈chars/4。
 * 取保守侧：低估 → 撑爆真实窗口是不对称风险（如俄语截获素材若按 chars/4 会低估约 4×）。
 */
function estStringTokens(s: string): number {
  let wide = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 0x80) wide++;
  }
  return wide + Math.ceil((s.length - wide) / 4);
}

/** 单 chunk 估算，计入 `callModel` 每片段的 `[chunk_id] ` 框架与分隔开销（评审）。 */
export function estChunkTokens(c: Chunk): number {
  return estStringTokens(`[${c.chunk_id}] ${c.text}`) + 1;
}

/** 一批 chunk 进上下文的估算 token 总量。 */
export function estTokens(chunks: Chunk[]): number {
  return chunks.reduce((sum, c) => sum + estChunkTokens(c), 0);
}

export interface ContextSelection {
  used: Chunk[];
  mode: "full" | "retrieval";
}

/**
 * 问答取材（query 驱动）：预算内 → 全上下文（used=全集，零召回风险）；
 * 否则 / 未设预算 → BM25 检索 top-k（Spec §5.1）。预算 opt-in：未配置即退一期路径。
 */
export function selectContext(query: string, chunks: Chunk[], budget: number | null, k = 6): ContextSelection {
  if (budget !== null && estTokens(chunks) <= budget * BUDGET_SAFETY) {
    return { used: chunks, mode: "full" };
  }
  return { used: retrieve(query, chunks, k).map((h) => h.chunk), mode: "retrieval" };
}

/**
 * 要素抽取取材（无 query，扫全量）：预算内全取，超预算按文档序贪心截到预算内
 * （Spec §5.1，取代 element-service 的 MAX_CHUNKS 静默截断；至少保留 1 块）。
 */
export function fitToBudget(chunks: Chunk[], budget: number): { used: Chunk[]; truncated: boolean } {
  const limit = budget * BUDGET_SAFETY;
  const used: Chunk[] = [];
  let acc = 0;
  for (const c of chunks) {
    const t = estChunkTokens(c);
    if (used.length > 0 && acc + t > limit) break;
    used.push(c);
    acc += t;
  }
  return { used, truncated: used.length < chunks.length };
}

/**
 * 稠密检索 + 混合 RRF（二期 §5.2）。精确暴力余弦（不漏匹配，对溯源关键）；RRF 融合排名
 * 而非分数，规避 BM25/cosine 量纲不可比。embedding 不可用时退 BM25-only。
 */

/** 候选过取回深度：先各取较宽再融合截 top-k。 */
function candidateDepth(k: number): number {
  return Math.max(k * 4, 24);
}

function cosine(a: Float32Array, b: Float32Array): number {
  // 维度不符不可比：版本戳校验（loadCaseVectors）本应已拦截，此处防御性兜底——
  // 宁可判 0（排末位）也不 Math.min 静默截断算垃圾相似度（§5.3 维度不匹配之忧）。
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** 进程内暴力余弦 top-n（返回 chunk_id，降序）。 */
export function denseSearch(queryVec: Float32Array, byId: Map<string, Float32Array>, n: number): string[] {
  return [...byId.entries()]
    .map(([id, v]) => ({ id, score: cosine(queryVec, v) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((s) => s.id);
}

/** Reciprocal Rank Fusion（k=60）：score = Σ 1/(k + rank)（rank 1-based），按融合分降序。 */
export function rrf(rankings: readonly (readonly string[])[], k = 60): string[] {
  const score = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * 混合检索：BM25 ⊕ dense via RRF → top-k。queryVec/向量缺失即退 BM25-only（不报错）。
 * used 即喂模型且供 Citation 校验的候选集——溯源红线两路同一 resolveValidCitations。
 */
export function retrieveHybrid(
  query: string,
  chunks: Chunk[],
  queryVec: Float32Array | null,
  byId: Map<string, Float32Array>,
  k = 6,
): Chunk[] {
  const byChunkId = new Map(chunks.map((c) => [c.chunk_id, c]));
  const depth = candidateDepth(k);
  const bm25Ranked = retrieve(query, chunks, depth).map((h) => h.chunk.chunk_id);
  const pick = (ids: string[]): Chunk[] => ids.slice(0, k).map((id) => byChunkId.get(id)).filter((c): c is Chunk => Boolean(c));
  if (!queryVec || byId.size === 0) {
    return pick(bm25Ranked); // 退 BM25-only
  }
  const denseRanked = denseSearch(queryVec, byId, depth);
  return pick(rrf([bm25Ranked, denseRanked], 60));
}

/**
 * 重排二阶段（二期 §5.2，可选门控）：RerankerAdapter 对融合候选精排，取 top-k。
 * 纯变换——是否启用（配置 + 候选数门控）与出站授权由调用方负责（与 embed 一致，§3.2）。
 * 分数同序对齐候选；缺失分数判 0（排末位）而非丢候选——溯源候选集不可悄悄缩水。
 */
export async function rerankTopK(
  query: string,
  candidates: Chunk[],
  reranker: RerankerAdapter,
  k: number,
): Promise<Chunk[]> {
  if (candidates.length === 0) return [];
  const scores = await reranker.rerank(query, candidates.map(indexText));
  return candidates
    .map((chunk, i) => ({ chunk, score: scores[i] ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.chunk);
}
