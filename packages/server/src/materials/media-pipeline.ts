import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Chunk, ChunkLocator, Modality } from "../domain/types.js";
import type { AsrAdapter, AsrResult, ModelSlots, OcrLine, VlmAdapter, OcrAdapter } from "../model/slots.js";
import { sha256 } from "../util/hash.js";
import { detectShots, extractAudioWav, extractFrame, ffmpegAvailable, probeDuration } from "./ffmpeg.js";

/**
 * 媒体加工管线（二期 §4.2/§4.3/§4.4）。媒体不是新子系统，只是新的 chunk 生产者：产出与
 * 文档相同格式的 Chunk（modality + timecode/bbox/speaker/frame locator + content_hash），
 * 即可被 loadCaseChunks/检索/Citation/问答/要素全部不改即引用。
 *
 * 视频优先走本地 ffmpeg 分镜/抽帧/抽音频；不可用或失败时回落确定性 mock。
 * 配文/转写/OCR 经 VLM/ASR/OCR 适配器。
 */

const SHOT_SECONDS = 10;

function tc(start: number, end: number): string {
  return `${start}-${end}`;
}

function makeChunk(materialId: string, chunkId: string, modality: Modality, text: string, locator: ChunkLocator): Chunk {
  return { chunk_id: chunkId, material_id: materialId, modality, locator, text, content_hash: sha256(text) };
}

/** mock 时长：从字节数确定性折算（无真实解码，与 MockAsr 一致）。 */
function mockDuration(bytes: Buffer): number {
  return Math.max(1, Math.round(bytes.length / 1000));
}

// ==================== 音频 ====================

export interface AudioProcessResult {
  chunks: Chunk[];
  media: AsrResult;
  duration: number;
}

/**
 * 音频 → 可引用 chunk。切块粒度 = ASR 段（一句话+时间码+说话人即天然引用单元，§4.2）。
 * chunk_id 带版本前缀（§2.5）：重加工生成新版本，旧 Citation 仍指向旧 chunk（hash 一致）→ 不失效。
 */
export async function processAudio(materialId: string, version: number, audio: Buffer, asr: AsrAdapter): Promise<AudioProcessResult> {
  const media = await asr.transcribe(audio);
  const chunks = media.segments.map((seg, idx) =>
    makeChunk(materialId, `${materialId}.v${version}#${idx}`, "audio", seg.text, { timecode: tc(seg.start, seg.end), speaker: seg.speaker }),
  );
  return { chunks, media, duration: media.duration };
}

// ==================== 视频 ====================

export type MediaFrameFormat = "svg" | "png";

export interface MediaFrame {
  /** 帧标识（= 镜头序号），由 MaterialService 按 format 落到 `processed/<mid>.frames/<key>.<ext>`。 */
  key: string;
  format: MediaFrameFormat;
  content: Buffer;
}

interface ShotMeta {
  t1: number;
  t2: number;
  frameKey: string;
  frameFormat: MediaFrameFormat;
  caption: string | null;
  ocr: OcrLine[];
}

export interface VideoProcessResult {
  chunks: Chunk[];
  frames: MediaFrame[];
  duration: number;
  media: { kind: "video"; duration: number; shots: ShotMeta[]; transcript: AsrResult | null };
  /** 部分失败/未配置说明（§4.5：部分成功仍 done + note）。 */
  notes: string[];
  engine: string;
}

/** mock 关键帧（SVG 占位，浏览器可渲染 + 框选；真实帧由 ffmpeg 抽，P2.6）。 */
function mockFrame(t: number): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#0f1729"/><text x="160" y="95" fill="#5ee7a8" font-family="monospace" font-size="15" text-anchor="middle">mock frame @ ${t}s</text></svg>`;
  return Buffer.from(svg, "utf8");
}

/**
 * 视频入库预处理（§4.3，非查询时现场喂 VLM）：mock 分镜 → 每镜头关键帧 → VLM 配文 +
 * 帧 OCR + 音轨转写 → 三类 chunk（均 modality:"video"）。部分失败不阻断（note 记）。
 */
export async function processVideo(
  materialId: string,
  version: number,
  video: Buffer,
  slots: Pick<ModelSlots, "asr" | "vlm" | "ocr">,
): Promise<VideoProcessResult> {
  const chunks: Chunk[] = [];
  const frames: MediaFrame[] = [];
  const shots: ShotMeta[] = [];
  const notes: string[] = [];
  const engines: string[] = [];
  let capIdx = 0;
  let ocrIdx = 0;
  let duration = mockDuration(video);
  let ranges: [number, number][] = [];
  let frameImages: Buffer[] = [];
  let frameFormat: MediaFrameFormat = "svg";
  let asrInput = video;
  let tmpDir: string | null = null;

  try {
    if (!(await ffmpegAvailable())) throw new Error("ffmpeg not found");
    tmpDir = await mkdtemp(path.join(tmpdir(), "iw-ffmpeg-"));
    const file = path.join(tmpDir, "input.video");
    await writeFile(file, video);
    duration = await probeDuration(file);
    ranges = await detectShots(file, duration);
    for (const [t1, t2] of ranges) frameImages.push(await extractFrame(file, (t1 + t2) / 2));
    asrInput = await extractAudioWav(file);
    frameFormat = "png";
    engines.push("ffmpeg");
  } catch {
    notes.push("real shot detection unavailable (ffmpeg not found)");
    duration = mockDuration(video);
    ranges = [];
    frameImages = [];
    frameFormat = "svg";
    asrInput = video;
    // mock 分镜（TransNetV2 形态）：按固定时长切镜头。
    for (let t = 0; t < duration; t += SHOT_SECONDS) ranges.push([t, Math.min(t + SHOT_SECONDS, duration)]);
    if (ranges.length === 0) ranges.push([0, duration]);
    for (const [t1] of ranges) frameImages.push(mockFrame(t1));
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  }

  if (slots.vlm) engines.push(slots.vlm.engine);
  else notes.push("VLM 未配置：跳过镜头配文");
  if (slots.ocr) engines.push(slots.ocr.engine);
  else notes.push("OCR 未配置：跳过帧 OCR");

  for (let si = 0; si < ranges.length; si++) {
    const [t1, t2] = ranges[si];
    const frame = frameImages[si] ?? mockFrame(t1);
    const key = String(si);
    frames.push({ key, format: frameFormat, content: frame });
    let caption: string | null = null;
    let ocrLines: OcrLine[] = [];
    if (slots.vlm) {
      try {
        caption = await slots.vlm.caption([frame]);
      } catch (e) {
        notes.push(`镜头配文失败@${key}s：${(e as Error).message}`);
      }
    }
    if (slots.ocr) {
      try {
        ocrLines = (await slots.ocr.ocr(frame)).lines;
      } catch (e) {
        notes.push(`帧 OCR 失败@${key}s：${(e as Error).message}`);
      }
    }
    if (caption) {
      chunks.push(makeChunk(materialId, `${materialId}.v${version}.cap#${capIdx++}`, "video", caption, { timecode: tc(t1, t2), frame: si }));
    }
    for (const line of ocrLines) {
      chunks.push(makeChunk(materialId, `${materialId}.v${version}.ocr#${ocrIdx++}`, "video", line.text, { timecode: tc(t1, t2), bbox: line.bbox, frame: si }));
    }
    shots.push({ t1, t2, frameKey: key, frameFormat, caption, ocr: ocrLines });
  }

  // 音轨转写（走 ASR）→ modality:"video" 转写 chunk。
  let transcript: AsrResult | null = null;
  if (slots.asr) {
    try {
      transcript = await slots.asr.transcribe(asrInput);
      engines.push(slots.asr.engine);
      transcript.segments.forEach((seg, i) =>
        chunks.push(makeChunk(materialId, `${materialId}.v${version}.tr#${i}`, "video", seg.text, { timecode: tc(seg.start, seg.end), speaker: seg.speaker })),
      );
    } catch (e) {
      notes.push(`音轨转写失败：${(e as Error).message}`);
    }
  } else {
    notes.push("ASR 未配置：跳过音轨转写");
  }

  return { chunks, frames, duration, media: { kind: "video", duration, shots, transcript }, notes, engine: engines.join("+") || "none" };
}

// ==================== 图像 ====================

export interface ImageProcessResult {
  chunks: Chunk[];
  media: { kind: "image"; caption: string | null; ocr: OcrLine[] };
  notes: string[];
  engine: string;
}

/** 图像 → VLM 配文（整图 bbox）+ OCR（区域 bbox），modality:"image"（§4.4）。 */
export async function processImage(
  materialId: string,
  version: number,
  image: Buffer,
  slots: { vlm: VlmAdapter | null; ocr: OcrAdapter | null },
): Promise<ImageProcessResult> {
  const chunks: Chunk[] = [];
  const notes: string[] = [];
  const engines: string[] = [];
  let caption: string | null = null;
  let ocrLines: OcrLine[] = [];

  if (slots.vlm) {
    try {
      caption = await slots.vlm.caption([image]);
      engines.push(slots.vlm.engine);
    } catch (e) {
      notes.push(`配文失败：${(e as Error).message}`);
    }
  } else {
    notes.push("VLM 未配置：跳过配文");
  }
  if (slots.ocr) {
    try {
      ocrLines = (await slots.ocr.ocr(image)).lines;
      engines.push(slots.ocr.engine);
    } catch (e) {
      notes.push(`OCR 失败：${(e as Error).message}`);
    }
  } else {
    notes.push("OCR 未配置：跳过 OCR");
  }

  if (caption) chunks.push(makeChunk(materialId, `${materialId}.v${version}.cap#0`, "image", caption, { bbox: [0, 0, 1, 1] }));
  ocrLines.forEach((line, i) => chunks.push(makeChunk(materialId, `${materialId}.v${version}.ocr#${i}`, "image", line.text, { bbox: line.bbox })));

  return { chunks, media: { kind: "image", caption, ocr: ocrLines }, notes, engine: engines.join("+") || "none" };
}
