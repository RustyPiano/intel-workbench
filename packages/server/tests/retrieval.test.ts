import { describe, expect, it } from "vitest";

import type { Chunk } from "../src/domain/types.js";
import { denseSearch, estChunkTokens, estTokens, fitToBudget, retrieve, retrieveHybrid, rrf, selectContext, tokenize } from "../src/inquiry/retrieval.js";

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
    // 非 ASCII（如俄语）保守计 ~1/字，不被当成 ASCII 低估约 4×（fail-safe）。
    expect(estChunkTokens(chunk("a", "Привет"))).toBeGreaterThanOrEqual(6);
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

describe("稠密检索 + 混合 RRF（二期 §5.2）", () => {
  const chunks = [
    chunk("m#0", "南海周边发现可疑舰船活动"),
    chunk("m#1", "今日天气晴朗适合外出"),
    chunk("m#2", "舰船编号与呼号存在关联"),
  ];

  it("rrf 融合排名符合公式 Σ1/(60+rank)", () => {
    // a:1/61+1/63, b:1/62+1/61, c:1/63+1/62 → b>a>c。
    expect(rrf([["a", "b", "c"], ["b", "c", "a"]], 60)).toEqual(["b", "a", "c"]);
  });

  it("denseSearch：按余弦降序返回 top-n chunk_id", () => {
    const byId = new Map([
      ["m#0", new Float32Array([1, 0, 0])],
      ["m#1", new Float32Array([0, 1, 0])],
      ["m#2", new Float32Array([0.9, 0.1, 0])],
    ]);
    const ranked = denseSearch(new Float32Array([1, 0, 0]), byId, 2);
    expect(ranked[0]).toBe("m#0"); // 与查询同向最相似
    expect(ranked).toContain("m#2");
    expect(ranked).toHaveLength(2);
  });

  it("retrieveHybrid：有向量 → BM25⊕dense 融合；缺向量/空 byId → 退 BM25-only", () => {
    const byId = new Map([
      ["m#0", new Float32Array([1, 0, 0])],
      ["m#1", new Float32Array([0, 1, 0])],
      ["m#2", new Float32Array([0.8, 0.2, 0])],
    ]);
    const hybrid = retrieveHybrid("可疑舰船", chunks, new Float32Array([1, 0, 0]), byId, 3);
    expect(hybrid.length).toBeGreaterThan(0);
    // 退化：queryVec=null 或空 byId → 等价 BM25 top-k。
    const bm25 = retrieve("可疑舰船", chunks, 3).map((h) => h.chunk.chunk_id);
    const degradedNull = retrieveHybrid("可疑舰船", chunks, null, byId, 3).map((c) => c.chunk_id);
    const degradedEmpty = retrieveHybrid("可疑舰船", chunks, new Float32Array([1, 0, 0]), new Map(), 3).map((c) => c.chunk_id);
    expect(degradedNull).toEqual(bm25);
    expect(degradedEmpty).toEqual(bm25);
  });
});
