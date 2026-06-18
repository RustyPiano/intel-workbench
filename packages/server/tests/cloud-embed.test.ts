import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudEmbedAdapter, mapEmbeddingResponse } from "../src/model/cloud-embed.js";

describe("mapEmbeddingResponse（OpenAI 兼容 /embeddings → Float32 向量批）", () => {
  it("按 index 还原顺序映射为同序 Float32Array（用 Float32 可精确表示的值）", () => {
    const out = mapEmbeddingResponse(
      { data: [{ index: 1, embedding: [0.75, -0.5] }, { index: 0, embedding: [0.5, 0.25] }] },
      2,
      2,
    );
    expect(out).toHaveLength(2);
    expect(Array.from(out[0])).toEqual([0.5, 0.25]);
    expect(Array.from(out[1])).toEqual([0.75, -0.5]);
  });

  it("条数不符 / 维度不符 / 缺 data / 非有限值 → 抛出（fail-closed，绝不污染 .vec）", () => {
    expect(() => mapEmbeddingResponse({ data: [{ index: 0, embedding: [0.5] }] }, 1, 2)).toThrow(/条数不符/);
    expect(() => mapEmbeddingResponse({ data: [{ index: 0, embedding: [0.5, 0.25] }] }, 3, 1)).toThrow(/维度不符/);
    expect(() => mapEmbeddingResponse({}, 2, 1)).toThrow(/data/);
    expect(() => mapEmbeddingResponse({ data: [{ index: 0, embedding: [0.5, "x"] }] }, 2, 1)).toThrow(/非有限值/);
  });
});

describe("CloudEmbedAdapter.embed（mock fetch，不连真服务）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("空输入直接返回 []，不发请求", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const adapter = new CloudEmbedAdapter("http://embed.local:8002/v1", { model: "m", dim: 2 });
    await expect(adapter.embed([])).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(0);
  });

  it("POST 到 <baseURL>/embeddings（末尾斜杠规整）+ Bearer 头 + {model,input}，响应映射为向量", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ index: 0, embedding: [0.5, 0.25] }] }),
    }));
    vi.stubGlobal("fetch", fetch);
    const adapter = new CloudEmbedAdapter("http://embed.local:8002/v1/", { model: "Qwen3-Embedding-0.6B", apiKey: "k", dim: 2 });
    const out = await adapter.embed(["南海舰船活动"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("http://embed.local:8002/v1/embeddings");
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(JSON.parse(init.body as string)).toEqual({ model: "Qwen3-Embedding-0.6B", input: ["南海舰船活动"], encoding_format: "float" });
    expect(Array.from(out[0])).toEqual([0.5, 0.25]);
    expect(adapter.dim).toBe(2);
    expect(adapter.modelId).toBe("Qwen3-Embedding-0.6B");
  });

  it("非 2xx 抛出，不静默吞掉", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(
      new CloudEmbedAdapter("http://embed.local:8002/v1", { model: "m", dim: 2 }).embed(["x"]),
    ).rejects.toThrow(/500/);
  });

  it("超 MAX_BATCH(32) 自动分批，跨批按序拼接（含 index 乱序还原）", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const input = JSON.parse(init.body as string).input as string[];
      // 故意逆序返回（带正确 index），验证 mapper 按 index 还原 + 分批按序拼接
      const data = input.map((t, k) => ({ index: k, embedding: [Number(t)] })).reverse();
      return { ok: true, status: 200, json: async () => ({ data }) };
    });
    vi.stubGlobal("fetch", fetch);
    const adapter = new CloudEmbedAdapter("http://embed.local:8002/v1", { model: "m", dim: 1 });
    const texts = Array.from({ length: 70 }, (_, i) => String(i));
    const out = await adapter.embed(texts);
    expect(fetch).toHaveBeenCalledTimes(3); // 32 + 32 + 6
    expect(out).toHaveLength(70);
    for (let i = 0; i < 70; i++) expect(out[i][0]).toBe(i);
  });

  it("构造期校验：缺 model / 维度非正 → 立即报错", () => {
    expect(() => new CloudEmbedAdapter("http://x/v1", { model: "m", dim: 0 })).toThrow(/维度/);
    expect(() => new CloudEmbedAdapter("http://x/v1", { model: "", dim: 2 })).toThrow(/model/);
  });
});
