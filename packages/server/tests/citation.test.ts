import { describe, expect, it } from "vitest";

import type { Chunk } from "../src/domain/types.js";
import { chunkToCitation, resolveValidCitations } from "../src/inquiry/citation.js";
import { sha256 } from "../src/util/hash.js";

/**
 * Citation 透传与红线校验（二期 Spec §2.2）。chunkToCitation 不再硬编码 "doc"：
 * 透传 chunk 自带 modality + locator（时间码/说话人/bbox），且 `resolveValidCitations`
 * 的 sha256 校验对所有模态一致（媒体 chunk 自动适用，无需第二套校验）。
 */

function audioChunk(text: string, id = "m#0"): Chunk {
  return {
    chunk_id: id,
    material_id: "m",
    modality: "audio",
    locator: { timecode: "00:00:01.000-00:00:04.500", speaker: "Speaker 1" },
    text,
    content_hash: sha256(text),
  };
}

describe("chunkToCitation 透传（二期 Spec §2.2）", () => {
  it("audio chunk 透传 timecode/speaker + 正确 modality", () => {
    const c = chunkToCitation(audioChunk("舰船编号已确认"), "通话录音.mp3");
    expect(c.modality).toBe("audio");
    expect(c.locator.timecode).toBe("00:00:01.000-00:00:04.500");
    expect(c.locator.speaker).toBe("Speaker 1");
    expect(c.material_name).toBe("通话录音.mp3");
    expect(c.content_hash).toBe(sha256("舰船编号已确认"));
  });

  it("旧格式 chunk（无 modality 字段）缺省 modality=doc", () => {
    // 模拟从旧 chunks.jsonl 读出的、缺新字段的行。
    const legacy = JSON.parse(
      JSON.stringify({ chunk_id: "m#0", material_id: "m", locator: { paragraph: 1 }, text: "旧正文", content_hash: sha256("旧正文") }),
    ) as Chunk;
    const c = chunkToCitation(legacy, "旧文档.txt");
    expect(c.modality).toBe("doc");
    expect(c.locator.paragraph).toBe(1);
  });
});

describe("resolveValidCitations 红线对媒体 chunk 模态无关（二期 Spec §2.2）", () => {
  it("音频 chunk hash 一致 → 生成带 timecode 的有效引用", () => {
    const chunk = audioChunk("有效转写");
    const byId = new Map([[chunk.chunk_id, chunk]]);
    const names = new Map([[chunk.material_id, "录音.wav"]]);
    const cites = resolveValidCitations([chunk.chunk_id], byId, names);
    expect(cites).toHaveLength(1);
    expect(cites[0].modality).toBe("audio");
    expect(cites[0].locator.timecode).toBeTruthy();
  });

  it("音频 chunk 被篡改（content_hash 对不上）→ 丢弃，与文档同规则", () => {
    const chunk = audioChunk("原始转写");
    const tampered: Chunk = { ...chunk, text: "被篡改的转写" }; // content_hash 仍指向原文
    const byId = new Map([[tampered.chunk_id, tampered]]);
    const names = new Map([[tampered.material_id, "录音.wav"]]);
    expect(resolveValidCitations([tampered.chunk_id], byId, names)).toHaveLength(0);
  });
});
