import { afterEach, describe, expect, it, vi } from "vitest";

import { FunAsrAdapter, mapFunAsrResponse } from "../src/model/funasr-adapter.js";

describe("mapFunAsrResponse（funasr-service /asr → AsrResult）", () => {
  it("段含 start/end(秒)+speaker+text；空文本丢弃；speaker 缺失→undefined", () => {
    const out = mapFunAsrResponse({
      duration: 10.5,
      segments: [
        { start: 0, end: 3.2, speaker: "说话人1", text: " 第一句 " },
        { start: 3.2, end: 6.0, speaker: "说话人2", text: "第二句" },
        { start: 6, end: 6.1, speaker: "说话人1", text: "   " }, // 空文本 → 丢弃
        { start: 7, end: 8, text: "无说话人" }, // speaker 缺失
      ],
    });
    expect(out.duration).toBe(10.5);
    expect(out.segments).toEqual([
      { start: 0, end: 3.2, speaker: "说话人1", text: "第一句" },
      { start: 3.2, end: 6.0, speaker: "说话人2", text: "第二句" },
      { start: 7, end: 8, speaker: undefined, text: "无说话人" },
    ]);
  });

  it("缺字段安全降级：无 segments→[]；duration 非数→0", () => {
    expect(mapFunAsrResponse({})).toEqual({ duration: 0, segments: [] });
    expect(mapFunAsrResponse({ duration: "x", segments: "nope" })).toEqual({ duration: 0, segments: [] });
  });
});

describe("FunAsrAdapter.transcribe（mock fetch）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POST /asr：multipart(file) + 映射富响应（带 speaker/时间戳）", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ duration: 5, segments: [{ start: 0, end: 5, speaker: "说话人1", text: "南海舰船活动" }] }),
    }));
    vi.stubGlobal("fetch", fetch);
    const adapter = new FunAsrAdapter("http://127.0.0.1:8001/", { model: "paraformer-zh" });
    const out = await adapter.transcribe(Buffer.from("fake-wav"));
    expect(out).toEqual({ duration: 5, segments: [{ start: 0, end: 5, speaker: "说话人1", text: "南海舰船活动" }] });
    expect(adapter.engine).toBe("funasr:paraformer-zh");
    expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:8001/asr"); // 末尾斜杠规整
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("非 2xx 抛出", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    await expect(new FunAsrAdapter("http://127.0.0.1:8001").transcribe(Buffer.from("x"))).rejects.toThrow(/503/);
  });
});
