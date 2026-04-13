import { describe, expect, test } from "vitest";

import { OpenAICompatibleModelAdapter } from "../../src/model/openai-compatible.js";

describe("OpenAICompatibleModelAdapter", () => {
  test("surfaces upstream provider details from OpenRouter-style 429 errors", async () => {
    const adapter = new OpenAICompatibleModelAdapter({
      provider: "openai-compatible",
      model: "google/gemma-4-31b-it:free",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "test-key",
    });

    (adapter as unknown as { client: { chat: { completions: { create: () => Promise<never> } } } }).client = {
      chat: {
        completions: {
          async create() {
            const error = new Error("429 Provider returned error") as Error & {
              status: number;
              error: {
                message: string;
                code: number;
                metadata: {
                  raw: string;
                  provider_name: string;
                  is_byok: boolean;
                };
              };
            };
            error.status = 429;
            error.error = {
              message: "Provider returned error",
              code: 429,
              metadata: {
                raw: JSON.stringify({
                  error: {
                    code: 429,
                    message: "Your prepayment credits are depleted.",
                    status: "RESOURCE_EXHAUSTED",
                  },
                }),
                provider_name: "Google AI Studio",
                is_byok: true,
              },
            };
            throw error;
          },
        },
      },
    };

    await expect(
      adapter.generate({
        systemPrompt: "You are a test.",
        messages: [],
        tools: [],
      }),
    ).rejects.toMatchObject({
      code: "MODEL_ERROR",
      message: "429 Google AI Studio: Your prepayment credits are depleted.",
      retriable: true,
      details: {
        status: 429,
        provider: "Google AI Studio",
        providerStatus: "RESOURCE_EXHAUSTED",
        isByok: true,
      },
    });
  });
});
