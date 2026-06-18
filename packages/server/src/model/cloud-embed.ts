/**
 * 真 Embedding 槽：OpenAI 兼容 `/embeddings` 端点（P3.D，照 PaddleOcrAdapter 同形）。
 * baseURL 约定为 OpenAI 兼容 base（含 /v1，如 `https://host/v1`），实际打 `${baseURL}/embeddings`。
 * 维度来自配置（`MINI_AGENT_EMBED_DIM`）→ 与 `.vec` 版本戳 dim/embed_model 对齐：换模型/维度即失效旧索引。
 * 边界：零外发授权（OfflineGuard.authorize）由调用方在出站前完成（检索/摄入），不写进适配器内部。
 */
import type { EmbeddingAdapter } from "./slots.js";

const MAX_BATCH = 32; // 单请求最多 32 条，超出自动分批（规避各家 input 上限），按序拼接。
const TIMEOUT_MS = 60_000;

function indexOf(item: unknown): number {
  const i = Number((item as { index?: unknown }).index);
  return Number.isFinite(i) ? i : 0;
}

/**
 * OpenAI 兼容 `/embeddings` 响应 → 同序 Float32 向量批。纯函数，便于单测覆盖。
 * 条数/维度/数值不符即抛（fail-closed：宁可报错也不写出污染 .vec 的垃圾向量）。
 */
export function mapEmbeddingResponse(json: unknown, dim: number, expectedCount: number): Float32Array[] {
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error("Embed 响应缺少 data 数组");
  if (data.length !== expectedCount) throw new Error(`Embed 响应条数不符：期望 ${expectedCount} 实得 ${data.length}`);
  // 多数实现按 index 有序返回；仍按 index 稳定排序兜底（缺 index 则保持原序）。
  const ordered = data.map((item, i) => ({ item, i })).sort((a, b) => indexOf(a.item) - indexOf(b.item) || a.i - b.i);
  return ordered.map(({ item }) => {
    const emb = (item as { embedding?: unknown }).embedding;
    if (!Array.isArray(emb) || emb.length !== dim) {
      throw new Error(`Embed 向量维度不符：期望 ${dim} 实得 ${Array.isArray(emb) ? emb.length : "非数组"}`);
    }
    const v = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      const n = Number(emb[i]);
      if (!Number.isFinite(n)) throw new Error("Embed 向量含非有限值");
      v[i] = n;
    }
    return v;
  });
}

export class CloudEmbedAdapter implements EmbeddingAdapter {
  readonly dim: number;
  readonly modelId: string;
  private readonly baseURL: string;
  private readonly apiKey: string;

  constructor(baseURL: string, opts: { model: string; apiKey?: string; dim: number }) {
    if (!opts.model) throw new Error("CloudEmbedAdapter 需要 model（设 MINI_AGENT_EMBED_MODEL）");
    if (!(opts.dim > 0)) throw new Error("CloudEmbedAdapter 需要正整数维度（设 MINI_AGENT_EMBED_DIM）");
    this.baseURL = baseURL.replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.modelId = opts.model;
    this.dim = opts.dim;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      out.push(...(await this.embedBatch(texts.slice(i, i + MAX_BATCH))));
    }
    return out;
  }

  private async embedBatch(batch: string[]): Promise<Float32Array[]> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const res = await fetch(`${this.baseURL}/embeddings`, {
      method: "POST",
      headers,
      // encoding_format:"float" 显式钉死：部分 OpenAI 兼容端默认/可返回 base64 编码向量，会悄悄破坏 float 数组映射。
      body: JSON.stringify({ model: this.modelId, input: batch, encoding_format: "float" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Embed HTTP ${res.status}`);
    return mapEmbeddingResponse(await res.json(), this.dim, batch.length);
  }
}
