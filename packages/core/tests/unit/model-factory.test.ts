import { describe, expect, test } from "vitest";

import { createModelAdapter } from "../../src/model/factory.js";
import { OpenAICompatibleModelAdapter } from "../../src/model/openai-compatible.js";

describe("createModelAdapter", () => {
  test("builds an OpenAI-compatible adapter with explicit baseURL and apiKey", () => {
    const adapter = createModelAdapter({
      provider: "openai-compatible",
      model: "gpt-4.1",
      baseURL: "https://example.com/v1",
      apiKey: "test-key",
    });

    expect(adapter).toBeInstanceOf(OpenAICompatibleModelAdapter);
    expect((adapter as OpenAICompatibleModelAdapter).connection).toMatchObject({
      provider: "openai-compatible",
      model: "gpt-4.1",
      baseURL: "https://example.com/v1",
      apiKey: "test-key",
    });
  });

  test("rejects unsupported model providers", () => {
    expect(() =>
      createModelAdapter({
        provider: "unsupported-provider",
        model: "gpt-4.1",
      }),
    ).toThrowErrorMatchingInlineSnapshot(`[RuntimeError: Unsupported model provider: unsupported-provider]`);
  });
});
