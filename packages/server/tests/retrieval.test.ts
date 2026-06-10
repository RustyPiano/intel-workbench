import { describe, expect, it } from "vitest";

import type { Chunk } from "../src/domain/types.js";
import { estChunkTokens, estTokens, fitToBudget, retrieve, selectContext, tokenize } from "../src/inquiry/retrieval.js";

function chunk(id: string, text: string): Chunk {
  return { chunk_id: id, material_id: "m", modality: "doc", locator: {}, text, content_hash: "" };
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

describe("token 预算路由（二期 Spec §5.1）", () => {
  const chunks = [
    chunk("m#0", "南海周边发现可疑舰船活动"),
    chunk("m#1", "今日天气晴朗适合外出"),
    chunk("m#2", "舰船编号与呼号存在关联"),
  ];

  it("estTokens：CJK≈1/字、含 [chunk_id] 框架与分隔开销", () => {
    // `[a] 中文`：4 ASCII(=ceil(4/4)=1) + 2 CJK(=2) + 1 分隔 = 4。
    expect(estChunkTokens(chunk("a", "中文"))).toBe(4);
    expect(estTokens([chunk("a", "中文")])).toBe(4);
    // 拉丁文本按 chars/4 折算，远小于等长 CJK。
    expect(estChunkTokens(chunk("a", "abcdefgh"))).toBeLessThan(estChunkTokens(chunk("a", "中文中文中文中文")));
  });

  it("预算内 → 全上下文（used=全集，mode=full）", () => {
    const sel = selectContext("天气", chunks, 10_000);
    expect(sel.mode).toBe("full");
    expect(sel.used).toHaveLength(3);
  });

  it("超预算 → 检索路（BM25 top-k，mode=retrieval）", () => {
    const sel = selectContext("可疑舰船", chunks, 1); // 预算极小 → 走检索
    expect(sel.mode).toBe("retrieval");
    expect(sel.used.length).toBeGreaterThan(0);
    expect(sel.used.every((c) => c.text.includes("舰船"))).toBe(true);
  });

  it("未设预算（null）→ 退检索路 top-k", () => {
    const sel = selectContext("可疑舰船", chunks, null);
    expect(sel.mode).toBe("retrieval");
  });

  it("fitToBudget：预算内全取不截断；超预算贪心截断但至少保留 1 块", () => {
    const full = fitToBudget(chunks, 10_000);
    expect(full.used).toHaveLength(3);
    expect(full.truncated).toBe(false);

    const tight = fitToBudget(chunks, 1);
    expect(tight.used).toHaveLength(1); // 至少 1 块
    expect(tight.truncated).toBe(true);
  });
});
