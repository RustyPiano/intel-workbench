/**
 * 本地 FunASR 槽：对接本机 funasr-service（独立项目 ../funasr，FastAPI 127.0.0.1:8001）。
 * 与云转写（`CloudAsrAdapter` 只返文本、无说话人/时间戳）不同：FunASR 全家桶
 * （fsmn-vad + ASR + ct-punc + cam++ 说话人分离）返回**句级时间戳 + 说话人**，
 * → `AsrResult.segments` 带 start/end(秒)/speaker，音频引用可精确跳播 + 按说话人分轨。
 * POST `${baseURL}/asr` multipart `file` → `{duration, segments:[{start,end,speaker,text}]}`。
 * 边界：零外发授权由调用方（摄入 process() 的 media-ingest）出站前完成，不写进适配器内部。
 */
import type { AsrAdapter, AsrOptions, AsrResult } from "./slots.js";

const TIMEOUT_MS = 300_000; // 本地 CPU 推理（含 cam++ 分离）可能较慢

/** funasr-service `/asr` 响应 → AsrResult。纯函数，便于单测。空文本段丢弃；speaker 缺失→undefined。 */
export function mapFunAsrResponse(json: unknown): AsrResult {
  const obj = (json ?? {}) as { duration?: unknown; segments?: unknown };
  const duration = Number(obj.duration);
  const raw = Array.isArray(obj.segments) ? obj.segments : [];
  const segments: AsrResult["segments"] = [];
  for (const s of raw) {
    const seg = s as { start?: unknown; end?: unknown; speaker?: unknown; text?: unknown };
    const text = typeof seg.text === "string" ? seg.text.trim() : "";
    if (!text) continue;
    const speaker = typeof seg.speaker === "string" && seg.speaker ? seg.speaker : undefined;
    segments.push({
      start: Number.isFinite(Number(seg.start)) ? Number(seg.start) : 0,
      end: Number.isFinite(Number(seg.end)) ? Number(seg.end) : 0,
      speaker,
      text,
    });
  }
  return { duration: Number.isFinite(duration) ? duration : 0, segments };
}

export class FunAsrAdapter implements AsrAdapter {
  readonly engine: string;
  private readonly baseURL: string;
  private readonly apiKey: string;

  constructor(baseURL: string, opts: { model?: string; apiKey?: string } = {}) {
    this.baseURL = baseURL.replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.engine = opts.model ? `funasr:${opts.model}` : "funasr";
  }

  async transcribe(audio: Buffer, opts?: AsrOptions): Promise<AsrResult> {
    const fd = new FormData();
    fd.append("file", new Blob([audio as unknown as BlobPart]), "audio.wav");
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const res = await fetch(`${this.baseURL}/asr`, {
      method: "POST",
      headers,
      body: fd,
      signal: opts?.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`FunASR HTTP ${res.status}`);
    return mapFunAsrResponse(await res.json());
  }
}
