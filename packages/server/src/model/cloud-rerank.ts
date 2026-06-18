/**
 * 真 Reranker 槽：SiliconFlow / Jina / Cohere 式 `/rerank` 端点（P3.D，照 CloudEmbedAdapter 同形）。
 * 非 OpenAI 核：POST `${baseURL}/rerank` {model,query,documents,top_n,return_documents} →
 * {results:[{index,relevance_score}]}（按相关性降序，index 指原位）。baseURL 约定含 /v1。
 * 槽契约 rerank(query,candidates)→同序分数：按 index 回填原序，缺失位（top_n<N）记 0=最不相关。
 * 边界：零外发授权由调用方（检索查询侧）出站前完成；rerank 不在摄入路径，无 ingest 出站。
 */
import type { RerankerAdapter } from "./slots.js";

const TIMEOUT_MS = 60_000;

/** /rerank 响应 → 同 candidates 序的分数数组。纯函数，便于单测。index 越界 / 分数非有限即抛（fail-closed）。 */
export function mapRerankResponse(json: unknown, expectedCount: number): number[] {
  const results = (json as { results?: unknown }).results;
  if (!Array.isArray(results)) throw new Error("Rerank 响应缺少 results 数组");
  const scores = new Array<number>(expectedCount).fill(0);
  for (const item of results) {
    const idx = Number((item as { index?: unknown }).index);
    const score = Number((item as { relevance_score?: unknown }).relevance_score);
    if (!Number.isInteger(idx) || idx < 0 || idx >= expectedCount) {
      throw new Error(`Rerank 结果 index 越界：${idx}（期望 0..${expectedCount - 1}）`);
    }
    if (!Number.isFinite(score)) throw new Error("Rerank relevance_score 非有限值");
    scores[idx] = score;
  }
  return scores;
}

export class CloudRerankAdapter implements RerankerAdapter {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(baseURL: string, opts: { model: string; apiKey?: string }) {
    if (!opts.model) throw new Error("CloudRerankAdapter 需要 model（设 MINI_AGENT_RERANK_MODEL）");
    this.baseURL = baseURL.replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.model = opts.model;
  }

  async rerank(query: string, candidates: string[]): Promise<number[]> {
    if (candidates.length === 0) return [];
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const res = await fetch(`${this.baseURL}/rerank`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.model, query, documents: candidates, top_n: candidates.length, return_documents: false }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Rerank HTTP ${res.status}`);
    return mapRerankResponse(await res.json(), candidates.length);
  }
}
