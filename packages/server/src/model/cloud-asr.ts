/**
 * 真 ASR 槽：OpenAI 兼容 `/audio/transcriptions`（multipart，P3.D，照 PaddleOcrAdapter 同形）。
 * baseURL 约定含 /v1。**云转写局限（实测 SiliconFlow SenseVoice）**：响应只有 {text}——
 * 无 speaker diarization、无段级时间戳、无 duration。故映射为「整段单段、无说话人」，
 * timecode 取 [0, 整段时长]（时长从 WAV 头解析，非 WAV/失败→0：此时 [0,0] 仅文本可检索/引用、无法精确回放）。部署换本地 FunASR(cam++)
 * 可补 speaker + 精确分段时间码。engine 记 `asr:<model>` 供审计/复核辨明是云转写。
 * 边界：零外发授权由调用方（摄入 process() 的 media-ingest）出站前完成，不写进适配器内部。
 */
import type { AsrAdapter, AsrOptions, AsrResult } from "./slots.js";

const TIMEOUT_MS = 180_000; // 音频转写可能较慢

/** 按魔数给 Blob 起带正确扩展名的文件名（部分端点按扩展名判格式）。未知按 wav。 */
export function sniffAudioName(b: Buffer): string {
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE") return "audio.wav";
  if (b.length >= 4 && b.toString("ascii", 0, 4) === "OggS") return "audio.ogg";
  if (b.length >= 4 && b.toString("ascii", 0, 4) === "fLaC") return "audio.flac";
  if (b.length >= 12 && b.toString("ascii", 4, 8) === "ftyp") return "audio.m4a";
  if (b.length >= 3 && b.toString("ascii", 0, 3) === "ID3") return "audio.mp3";
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "audio.mp3"; // MPEG 帧同步
  return "audio.wav";
}

/** 解析 canonical PCM WAV 时长（秒）。非 WAV / 解析失败 → 0（时间码退化为 [0,0]）。 */
export function wavDurationSeconds(b: Buffer): number {
  if (b.length < 12 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") return 0;
  let off = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "fmt " && off + 20 <= b.length) byteRate = b.readUInt32LE(off + 16); // fmt 体内 avgBytesPerSec
    if (id === "data") dataSize = size;
    off += 8 + size + (size % 2); // 块体偶数对齐
  }
  return byteRate > 0 ? dataSize / byteRate : 0;
}

/** 转写响应 {text} + 整段时长 → AsrResult（整段单段、无说话人）。空文本 → 无段（下游视作无可引用内容）。 */
export function mapTranscription(json: unknown, duration: number): AsrResult {
  const raw = (json as { text?: unknown }).text;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { duration, segments: [] };
  return { duration, segments: [{ start: 0, end: duration, text }] };
}

export class CloudAsrAdapter implements AsrAdapter {
  readonly engine: string;
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(baseURL: string, opts: { model: string; apiKey?: string }) {
    if (!opts.model) throw new Error("CloudAsrAdapter 需要 model（设 MINI_AGENT_ASR_MODEL）");
    this.baseURL = baseURL.replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.model = opts.model;
    this.engine = `asr:${opts.model}`;
  }

  async transcribe(audio: Buffer, opts?: AsrOptions): Promise<AsrResult> {
    const fd = new FormData();
    fd.append("model", this.model);
    fd.append("file", new Blob([audio as unknown as BlobPart]), sniffAudioName(audio));
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const res = await fetch(`${this.baseURL}/audio/transcriptions`, {
      method: "POST",
      headers,
      body: fd,
      signal: opts?.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ASR HTTP ${res.status}`);
    return mapTranscription(await res.json(), wavDurationSeconds(audio));
  }
}
