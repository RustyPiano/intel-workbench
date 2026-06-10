import type { Chunk } from "../domain/types.js";
import type { AsrAdapter, AsrResult } from "../model/slots.js";
import { sha256 } from "../util/hash.js";

/**
 * 媒体加工管线（二期 §4.2）。媒体不是新子系统，只是新的 chunk 生产者：产出与文档
 * 相同格式的 Chunk（带 modality + timecode/speaker locator + content_hash），即可被
 * loadCaseChunks/检索/Citation/问答/要素全部不改即引用。
 *
 * 本期音频垂直切片：fsmn-vad+ASR+cam++ 形态由 AsrAdapter 抽象（mock-first）。
 */

export interface AudioProcessResult {
  chunks: Chunk[];
  /** 原始 ASR 结果，落 `processed/<mid>.media.json`，供复核回放与重切块（不重跑模型）。 */
  media: AsrResult;
  duration: number;
}

/** 时间码 "start-end"（秒）。UI 跳播原片段（回听硬验收）即取此。 */
function timecode(start: number, end: number): string {
  return `${start}-${end}`;
}

/**
 * 音频 → 可引用 chunk。切块粒度 = ASR 段（一句话+时间码+说话人即天然引用单元，§4.2）。
 * chunk_id 带版本前缀（§2.5）：重加工生成新版本，旧 Citation 仍指向旧 chunk（hash 一致）→ 不失效。
 */
export async function processAudio(
  materialId: string,
  version: number,
  audio: Buffer,
  asr: AsrAdapter,
): Promise<AudioProcessResult> {
  const media = await asr.transcribe(audio);
  const chunks: Chunk[] = media.segments.map((seg, idx) => ({
    chunk_id: `${materialId}.v${version}#${idx}`,
    material_id: materialId,
    modality: "audio",
    locator: { timecode: timecode(seg.start, seg.end), speaker: seg.speaker },
    text: seg.text,
    content_hash: sha256(seg.text),
  }));
  return { chunks, media, duration: media.duration };
}
