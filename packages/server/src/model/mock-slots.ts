/**
 * 确定性 mock 适配器（二期 P2.2，mock-first）。同一输入永远同一输出——供测试与
 * 管线骨架联调；真实权重接入是 P2.6。**无语义**（embed 是 hash 向量），故只验
 * 接线/管线/退化，不验模型质量。
 */

import type {
  AsrAdapter,
  AsrOptions,
  AsrResult,
  EmbeddingAdapter,
  ModelSlots,
  OcrAdapter,
  OcrResult,
  RerankerAdapter,
  VlmAdapter,
} from "./slots.js";
import type { SlotConfigs } from "./slot-config.js";
import { PaddleOcrAdapter } from "./paddle-ocr.js";
import { CloudEmbedAdapter } from "./cloud-embed.js";
import { CloudRerankAdapter } from "./cloud-rerank.js";
import { CloudVlmAdapter } from "./cloud-vlm.js";
import { CloudAsrAdapter } from "./cloud-asr.js";
import { FunAsrAdapter } from "./funasr-adapter.js";

/** mock embedding 维度（确定性 hash 向量；P2.4 .vec 版本戳记此 dim）。 */
export const MOCK_EMBED_DIM = 8;
/** mock embedding 模型标识（P2.4 .vec 版本戳 embed_model）。 */
export const MOCK_EMBED_MODEL = "mock-embed";

const SEG_SECONDS = 5;

export class MockAsr implements AsrAdapter {
  readonly engine = "mock-asr";
  // 按"时长"造确定性段 + 交替说话人。时长从字节数确定性折算（无真实解码）。
  async transcribe(audio: Buffer, _opts?: AsrOptions): Promise<AsrResult> {
    const duration = Math.max(1, Math.round(audio.length / 1000));
    const segments = [];
    const n = Math.max(1, Math.ceil(duration / SEG_SECONDS));
    for (let k = 0; k < n; k++) {
      const start = k * SEG_SECONDS;
      const end = Math.min((k + 1) * SEG_SECONDS, duration);
      segments.push({ start, end, speaker: `说话人${(k % 2) + 1}`, text: `（mock 转写）第 ${k + 1} 段语音内容` });
    }
    return { language: "zh", duration, segments };
  }
}

export class MockVlm implements VlmAdapter {
  readonly engine = "mock-vlm";
  async caption(frames: Buffer[], _opts?: { signal?: AbortSignal }): Promise<string> {
    const bytes = frames.reduce((s, f) => s + f.length, 0);
    return `（mock 配文）画面含 ${frames.length} 帧，共 ${bytes} 字节`;
  }
}

export class MockOcr implements OcrAdapter {
  readonly engine = "mock-ocr";
  async ocr(image: Buffer): Promise<OcrResult> {
    return { lines: [{ text: `（mock OCR）识别文本 ${image.length}B`, bbox: [0.1, 0.1, 0.8, 0.1] }] };
  }
}

export class MockEmbed implements EmbeddingAdapter {
  readonly dim = MOCK_EMBED_DIM;
  readonly modelId = MOCK_EMBED_MODEL;
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => embedOne(t));
  }
}

/** 确定性、归一化的 hash 向量（同文本同向量，供余弦检索 mock）。 */
function embedOne(text: string): Float32Array {
  const v = new Float32Array(MOCK_EMBED_DIM);
  for (let i = 0; i < text.length; i++) {
    v[i % MOCK_EMBED_DIM] += text.charCodeAt(i);
  }
  let norm = 0;
  for (let i = 0; i < MOCK_EMBED_DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < MOCK_EMBED_DIM; i++) v[i] /= norm;
  return v;
}

export class MockReranker implements RerankerAdapter {
  // 确定性词面重叠分：候选含查询去重字符越多越高（无语义，仅供门控/接线验证）。
  async rerank(query: string, candidates: string[]): Promise<number[]> {
    const qchars = new Set(query.replace(/\s+/g, ""));
    return candidates.map((c) => {
      if (qchars.size === 0 || c.length === 0) return 0;
      let hit = 0;
      for (const ch of qchars) if (c.includes(ch)) hit++;
      return hit / qchars.size;
    });
  }
}

/**
 * 槽工厂（二期 P2.2/P3.D）。逐槽优先级：configured→real，其次 mockEnabled→mock，
 * 否则 null 降级。
 */
export function buildSlots(mockEnabled: boolean, configs?: SlotConfigs): ModelSlots {
  return {
    asr: configs?.asr.configured
      ? configs.asr.provider === "funasr"
        ? new FunAsrAdapter(configs.asr.baseURL, { model: configs.asr.model, apiKey: configs.asr.apiKey })
        : new CloudAsrAdapter(configs.asr.baseURL, { model: configs.asr.model, apiKey: configs.asr.apiKey })
      : mockEnabled
        ? new MockAsr()
        : null,
    vlm: configs?.vlm.configured
      ? new CloudVlmAdapter(configs.vlm.baseURL, { model: configs.vlm.model, apiKey: configs.vlm.apiKey })
      : mockEnabled
        ? new MockVlm()
        : null,
    ocr: configs?.ocr.configured
      ? new PaddleOcrAdapter(configs.ocr.baseURL, { model: configs.ocr.model, apiKey: configs.ocr.apiKey })
      : mockEnabled
        ? new MockOcr()
        : null,
    embed: configs?.embed.configured
      ? new CloudEmbedAdapter(configs.embed.baseURL, { model: configs.embed.model, apiKey: configs.embed.apiKey, dim: configs.embed.dim ?? 0 })
      : mockEnabled
        ? new MockEmbed()
        : null,
    rerank: configs?.rerank.configured
      ? new CloudRerankAdapter(configs.rerank.baseURL, { model: configs.rerank.model, apiKey: configs.rerank.apiKey })
      : mockEnabled
        ? new MockReranker()
        : null,
  };
}
