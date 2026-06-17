import { afterEach, describe, expect, it, vi } from "vitest";

import { PaddleOcrAdapter, mapPaddleResponse } from "../src/model/paddle-ocr.js";

describe("mapPaddleResponse（PaddleOCR JSON → 归一化 OcrResult）", () => {
  it("按 width/height 把像素 box 归一化为 [x,y,w,h]，null box 回落整帧，空文本丢弃", () => {
    const out = mapPaddleResponse({
      width: 1000,
      height: 2000,
      results: [
        { text: "甲", score: 0.9, box: [100, 200, 300, 260] },
        { text: "乙", score: 0.8, box: null },
        { text: "", score: 0.7, box: [0, 0, 1, 1] },
      ],
    });
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0].text).toBe("甲");
    // [100/1000, 200/2000, (300-100)/1000, (260-200)/2000]
    expect(out.lines[0].bbox).toEqual([0.1, 0.1, 0.2, 0.03]);
    expect(out.lines[1].text).toBe("乙");
    expect(out.lines[1].bbox).toEqual([0, 0, 1, 1]); // null → 整帧兜底
  });

  it("缺尺寸 / 非法 box / 空 results 安全降级，不抛出", () => {
    expect(mapPaddleResponse({ results: [{ text: "无尺寸", box: [1, 2, 3, 4] }] }).lines[0].bbox).toEqual([0, 0, 1, 1]);
    expect(mapPaddleResponse({ width: 100, height: 100, results: [{ text: "短框", box: [1, 2] }] }).lines[0].bbox).toEqual([0, 0, 1, 1]);
    expect(mapPaddleResponse({}).lines).toEqual([]);
    expect(mapPaddleResponse({ results: "nonsense" }).lines).toEqual([]);
  });
});

describe("PaddleOcrAdapter.ocr（mock fetch，不连真服务）", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POST 到 <baseURL>/ocr 并把响应映射成归一化结果", async () => {
    const calls: { url: string; method?: string; hasFile: boolean }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method, hasFile: init.body instanceof FormData });
        return new Response(
          JSON.stringify({ width: 200, height: 100, results: [{ text: "线索", box: [20, 10, 120, 40] }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const adapter = new PaddleOcrAdapter("http://ocr.local:8000/");
    const result = await adapter.ocr(Buffer.from("fake-image-bytes"));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://ocr.local:8000/ocr"); // 末尾斜杠被规整
    expect(calls[0].method).toBe("POST");
    expect(calls[0].hasFile).toBe(true);
    expect(result.lines).toEqual([{ text: "线索", bbox: [0.1, 0.1, 0.5, 0.3] }]);
    expect(adapter.engine).toBe("paddleocr");
  });

  it("非 2xx 抛出，不静默吞掉", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 503 })));
    await expect(new PaddleOcrAdapter("http://ocr.local:8000").ocr(Buffer.from("x"))).rejects.toThrow(/503/);
  });
});
