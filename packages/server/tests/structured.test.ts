import type { GenerateInput, GenerateResult, ModelAdapter } from "mini-agent";
import { describe, expect, it } from "vitest";

import { generateJson } from "../src/model/structured.js";

/** 捕获最后一次 generate 入参的桩 adapter，返回固定 JSON 内容。 */
function capturingAdapter(): { adapter: ModelAdapter; last: () => GenerateInput | undefined } {
  let captured: GenerateInput | undefined;
  const adapter: ModelAdapter = {
    name: "capture",
    async generate(input: GenerateInput): Promise<GenerateResult> {
      captured = input;
      return { message: { role: "assistant", content: '{"ok":1}' }, stopReason: "end_turn" };
    },
  };
  return { adapter, last: () => captured };
}

describe("generateJson thinking 透传", () => {
  it('thinking="disabled" 映射为 { type: "disabled" } 并透传 maxTokens', async () => {
    const { adapter, last } = capturingAdapter();
    const out = await generateJson(adapter, "sys", "user", { maxTokens: 1234, thinking: "disabled" });
    expect(out).toEqual({ ok: 1 });
    expect(last()?.thinking).toEqual({ type: "disabled" });
    expect(last()?.maxTokens).toBe(1234);
  });

  it('thinking="enabled" 映射为 { type: "enabled" }', async () => {
    const { adapter, last } = capturingAdapter();
    await generateJson(adapter, "sys", "user", { thinking: "enabled" });
    expect(last()?.thinking).toEqual({ type: "enabled" });
  });

  it("未指定 thinking 时不下发该字段（undefined）", async () => {
    const { adapter, last } = capturingAdapter();
    await generateJson(adapter, "sys", "user", {});
    expect(last()?.thinking).toBeUndefined();
  });

  it("已中止的外部 signal 会传入已中止 signal 并导致调用中止", async () => {
    const controller = new AbortController();
    controller.abort();
    let captured: GenerateInput | undefined;
    const adapter: ModelAdapter = {
      name: "abort-capture",
      async generate(input: GenerateInput): Promise<GenerateResult> {
        captured = input;
        if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        return { message: { role: "assistant", content: '{"ok":1}' }, stopReason: "end_turn" };
      },
    };

    await expect(generateJson(adapter, "sys", "user", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(captured?.signal?.aborted).toBe(true);
  });
});
