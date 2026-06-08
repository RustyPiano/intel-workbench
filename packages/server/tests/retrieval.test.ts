import { describe, expect, it } from "vitest";

import type { Chunk } from "../src/domain/types.js";
import { retrieve, tokenize } from "../src/inquiry/retrieval.js";

function chunk(id: string, text: string): Chunk {
  return { chunk_id: id, material_id: "m", locator: {}, text, content_hash: "" };
}

describe("BM25 兜底检索（§7.3 step 2）", () => {
  const chunks = [
    chunk("m#0", "南海周边发现可疑舰船活动，疑似军事演习"),
    chunk("m#1", "今日天气晴朗，适合外出散步"),
    chunk("m#2", "舰船编号与此前截获的呼号存在关联"),
  ];

  it("tokenize 产出拉丁词与中文 bigram", () => {
    const toks = tokenize("APT29 渗透");
    expect(toks).toContain("apt29");
    expect(toks).toContain("渗透");
  });

  it("相关片段排在前；按分降序", () => {
    const ranked = retrieve("可疑舰船", chunks);
    expect(ranked.length).toBeGreaterThan(0);
    expect(["m#0", "m#2"]).toContain(ranked[0].chunk.chunk_id);
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[ranked.length - 1].score);
  });

  it("无词项重叠 → 空（触发拒答）", () => {
    expect(retrieve("量子计算机芯片", chunks)).toEqual([]);
  });
});
