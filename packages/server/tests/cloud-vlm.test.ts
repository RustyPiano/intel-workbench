import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudVlmAdapter, extractCaption } from "../src/model/cloud-vlm.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe("extractCaption（多模态 /chat/completions → 配文）", () => {
  it("取 choices[0].message.content 并去空白", () => {
    expect(extractCaption({ choices: [{ message: { content: "  画面含一艘驱逐舰  " } }] })).toBe("画面含一艘驱逐舰");
  });

  it("content 为分段数组时拼接文本段（兼容部分端点）", () => {
    expect(
      extractCaption({ choices: [{ message: { content: [{ type: "text", text: "一艘" }, { type: "text", text: "护卫舰" }] } }] }),
    ).toBe("一艘护卫舰");
  });

  it("缺 choices / content 非字符串 → 抛出（fail-closed）", () => {
    expect(() => extractCaption({})).toThrow(/choices/);
    expect(() => extractCaption({ choices: [] })).toThrow(/choices/);
    expect(() => extractCaption({ choices: [{ message: { content: 123 } }] })).toThrow(/content/);
  });
});

describe("CloudVlmAdapter.caption（mock fetch）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("空帧直接返回 ''，不发请求", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(new CloudVlmAdapter("https://api.siliconflow.cn/v1", { model: "m" }).caption([])).resolves.toBe("");
    expect(fetch).toHaveBeenCalledTimes(0);
  });

  it("POST /chat/completions：多模态消息含提示+图(data URL，按魔数嗅探 MIME)，映射 content", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "画面含一架预警机" } }] }),
    }));
    vi.stubGlobal("fetch", fetch);
    const adapter = new CloudVlmAdapter("https://api.siliconflow.cn/v1/", { model: "Qwen/Qwen3-VL-32B-Instruct", apiKey: "k" });
    const out = await adapter.caption([PNG]);
    expect(out).toBe("画面含一架预警机");
    expect(adapter.engine).toBe("vlm:Qwen/Qwen3-VL-32B-Instruct");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://api.siliconflow.cn/v1/chat/completions");
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("Qwen/Qwen3-VL-32B-Instruct");
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content[0]).toMatchObject({ type: "text" });
    expect(body.messages[0].content[1].type).toBe("image_url");
    expect(body.messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it("JPEG 帧按 image/jpeg 嗅探", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "x" } }] }) }));
    vi.stubGlobal("fetch", fetch);
    await new CloudVlmAdapter("https://x/v1", { model: "m" }).caption([JPEG]);
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("非 2xx 抛出", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(new CloudVlmAdapter("https://x/v1", { model: "m" }).caption([PNG])).rejects.toThrow(/500/);
  });

  it("构造期缺 model 报错", () => {
    expect(() => new CloudVlmAdapter("https://x/v1", { model: "" })).toThrow(/model/);
  });
});
