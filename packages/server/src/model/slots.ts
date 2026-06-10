/**
 * 模型适配器槽接口（二期 Spec §3.2/§3.3）。Embedding/Reranker/ASR/VLM/OCR 统一为
 * 可插拔本地端点；本期只定接口 + mock 实现，真实权重接入是 P2.6（部署方）。
 *
 * 边界：适配器只做"输入→输出"纯变换；零外发授权（OfflineGuard.authorize）由调用方
 * 在出站前完成（与文本 LLM 一致），不写进适配器内部。
 */

/** ASR 转写段（贴合 FunASR 输出：段 + 说话人 + 时间戳，Spec §3.3）。 */
export interface AsrSegment {
  start: number; // 秒
  end: number; // 秒
  speaker?: string; // diarization 说话人标签
  text: string;
}
export interface AsrResult {
  language?: string;
  duration: number; // 秒
  segments: AsrSegment[];
}
export interface AsrOptions {
  language?: string;
  signal?: AbortSignal;
}
export interface AsrAdapter {
  /** 引擎名（如 SenseVoiceSmall / mock-asr）；记入 material.engine 供审计/复核（§6）。 */
  readonly engine: string;
  /** 音频字节 → 段（含时间码/说话人）。 */
  transcribe(audio: Buffer, opts?: AsrOptions): Promise<AsrResult>;
}

export interface VlmOptions {
  signal?: AbortSignal;
}
export interface VlmAdapter {
  /** 关键帧（一或多帧字节）→ 配文/理解文本。 */
  caption(frames: Buffer[], opts?: VlmOptions): Promise<string>;
}

/** OCR 一行/块：文本 + 归一化区域 [x,y,w,h]（Spec §3.2）。 */
export interface OcrLine {
  text: string;
  bbox: [number, number, number, number];
}
export interface OcrResult {
  lines: OcrLine[];
}
export interface OcrAdapter {
  /** 图像字节 → 带区域的文本块。 */
  ocr(image: Buffer): Promise<OcrResult>;
}

export interface EmbeddingAdapter {
  /** 向量维度（P2.4 `.vec` 版本戳 `dim`，Spec §5.3：维度变即失效旧索引）。 */
  readonly dim: number;
  /** 模型标识（P2.4 `.vec` 版本戳 `embed_model`：换模型即失效旧索引并标待重建）。 */
  readonly modelId: string;
  /** 文本批 → 向量批（同序，长度恒为 dim）。 */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface RerankerAdapter {
  /** 查询 + 候选 → 候选相关性分数（同序，越大越相关）。 */
  rerank(query: string, candidates: string[]): Promise<number[]>;
}

/** 全部槽集合；未启用/未配置的槽为 null（降级而非阻塞）。 */
export interface ModelSlots {
  asr: AsrAdapter | null;
  vlm: VlmAdapter | null;
  ocr: OcrAdapter | null;
  embed: EmbeddingAdapter | null;
  rerank: RerankerAdapter | null;
}
