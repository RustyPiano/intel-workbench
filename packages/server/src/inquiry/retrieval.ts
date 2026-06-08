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
