import type { Chunk } from "../domain/types.js";

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

const K1 = 1.5;
const B = 0.75;

/** BM25 打分，返回得分 > 0 的 top-k chunk（按分降序）。 */
export function retrieve(query: string, chunks: Chunk[], k = 6): ScoredChunk[] {
  if (chunks.length === 0) return [];
  const docTokens = chunks.map((c) => tokenize(c.text));
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
