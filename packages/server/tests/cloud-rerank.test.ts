import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudRerankAdapter, mapRerankResponse } from "../src/model/cloud-rerank.js";

describe("mapRerankResponse（/rerank → 同 candidates 序分数）", () => {
  it("降序/乱序结果按 index 回填原序", () => {
    expect(
      mapRerankResponse(
        { results: [{ index: 2, relevance_score: 0.8 }, { index: 0, relevance_score: 0.3 }, { index: 1, relevance_score: 0.0 }] },
        3,
      ),
    ).toEqual([0.3, 0.0, 0.8]);
  });

  it("top_n<N 部分结果：缺失位记 0（最不相关）", () => {
    expect(mapRerankResponse({ results: [{ index: 1, relevance_score: 0.9 }] }, 3)).toEqual([0, 0.9, 0]);
  });

  it("缺 results / index 越界 / 分数非有限 → 抛出（fail-closed）", () => {
    expect(() => mapRerankResponse({}, 2)).toThrow(/results/);
    expect(() => mapRerankResponse({ results: [{ index: 5, relevance_score: 0.5 }] }, 2)).toThrow(/越界/);
    expect(() => mapRerankResponse({ results: [{ index: 0, relevance_score: "x" }] }, 2)).toThrow(/非有限/);
  });
});

describe("CloudRerankAdapter.rerank（mock fetch）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("空候选直接返回 []，不发请求", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(new CloudRerankAdapter("https://api.siliconflow.cn/v1", { model: "m" }).rerank("q", [])).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(0);
  });

  it("POST 到 <baseURL>/rerank（末尾斜杠规整）+ Bearer + {model,query,documents,top_n}，映射回原序", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] }),
    }));
    vi.stubGlobal("fetch", fetch);
    const adapter = new CloudRerankAdapter("https://api.siliconflow.cn/v1/", { model: "Qwen/Qwen3-Reranker-8B", apiKey: "k" });
    const scores = await adapter.rerank("海军动向", ["天气", "舰艇部署"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://api.siliconflow.cn/v1/rerank");
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "Qwen/Qwen3-Reranker-8B",
      query: "海军动向",
      documents: ["天气", "舰艇部署"],
      top_n: 2,
      return_documents: false,
    });
    expect(scores).toEqual([0.1, 0.9]); // 原序：天气=0.1、舰艇部署=0.9
  });

  it("非 2xx 抛出", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(new CloudRerankAdapter("https://api.siliconflow.cn/v1", { model: "m" }).rerank("q", ["a"])).rejects.toThrow(/500/);
  });

  it("构造期缺 model 报错", () => {
    expect(() => new CloudRerankAdapter("https://x/v1", { model: "" })).toThrow(/model/);
  });
});
