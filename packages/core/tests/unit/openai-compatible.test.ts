import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import { OpenAICompatibleModelAdapter } from "../../src/model/openai-compatible.js";
import type { ModelStreamEvent } from "../../src/model/types.js";
import { getToolJsonSchema, type RuntimeTool } from "../../src/tools/types.js";

async function* chunks(...items: unknown[]): AsyncIterable<unknown> {
  for (const item of items) {
    yield item;
  }
}

async function collectStreamEvents(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("OpenAICompatibleModelAdapter", () => {
  test("rejects malformed provider responses that omit the choices array", async () => {
    const adapter = new OpenAICompatibleModelAdapter({
      provider: "openai-compatible",
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "test-key",
    });

    (adapter as unknown as { client: { chat: { completions: { create: () => Promise<unknown> } } } }).client = {
      chat: {
        completions: {
          async create() {
            return {
              id: "chatcmpl_malformed",
              object: "chat.completion",
            };
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
      message: "Provider returned malformed chat completion response: missing choices array",
      details: {
        category: "incompatible_response",
        responseKeys: ["id", "object"],
      },
    });
  });

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
              request_id: string;
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
            error.request_id = "req_abc123";
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
      (async () => {
        try {
          await adapter.generate({
            systemPrompt: "You are a test.",
            messages: [],
            tools: [],
          });
          throw new Error("expected provider error");
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect(error).toMatchObject({
            code: "MODEL_ERROR",
            retriable: true,
            details: {
              category: "quota",
              status: 429,
              provider: "Google AI Studio",
              providerStatus: "RESOURCE_EXHAUSTED",
              isByok: true,
              requestId: "req_abc123",
            },
          });
          expect((error as Error).message).toContain("429 Google AI Studio: Your prepayment credits are depleted.");
        }
      })(),
    ).resolves.toBeUndefined();
  });

  test("propagates request id from response headers when error.request_id is absent", async () => {
    const adapter = new OpenAICompatibleModelAdapter({
      model: "any-model",
      apiKey: "test-key",
    });

    (adapter as unknown as { client: { chat: { completions: { create: () => Promise<never> } } } }).client = {
      chat: {
        completions: {
          async create() {
            const error = new Error("boom") as Error & {
              status: number;
              headers: Record<string, string>;
            };
            error.status = 500;
            error.headers = { "x-request-id": "req_from_headers" };
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
      details: {
        requestId: "req_from_headers",
      },
    });
  });

  test("rejects tool calls whose arguments arrive as an object instead of a JSON string", async () => {
    const adapter = new OpenAICompatibleModelAdapter({
      model: "any-model",
      apiKey: "test-key",
    });

    (adapter as unknown as { client: { chat: { completions: { create: () => Promise<unknown> } } } }).client = {
      chat: {
        completions: {
          async create() {
            return {
              id: "chatcmpl_objargs",
              object: "chat.completion",
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: {
                          name: "read",
                          // intentionally an object — incompatible with OpenAI contract
                          arguments: { path: "/tmp/x" },
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            };
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
      message: "Provider returned tool call arguments as object instead of string",
      details: {
        category: "incompatible_response",
        name: "read",
      },
    });
  });

  test("rejects tool calls with null arguments and reports argumentsType for diagnostics", async () => {
    const adapter = new OpenAICompatibleModelAdapter({
      model: "any-model",
      apiKey: "test-key",
    });

    (adapter as unknown as { client: { chat: { completions: { create: () => Promise<unknown> } } } }).client = {
      chat: {
        completions: {
          async create() {
            return {
              id: "chatcmpl_nullargs",
              object: "chat.completion",
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "call_2",
                        type: "function",
                        function: {
                          name: "write",
                          arguments: null,
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            };
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
      message: "Provider returned missing or invalid tool call arguments",
      details: {
        category: "incompatible_response",
        name: "write",
        argumentsType: "object",
      },
    });
  });

  test("marks tool arguments JSON parse failures as incompatible_response", async () => {
    const adapter = new OpenAICompatibleModelAdapter({
      model: "any-model",
      apiKey: "test-key",
    });

    (adapter as unknown as { client: { chat: { completions: { create: () => Promise<unknown> } } } }).client = {
      chat: {
        completions: {
          async create() {
            return {
              id: "chatcmpl_badjson",
              object: "chat.completion",
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "call_3",
                        type: "function",
                        function: {
                          name: "edit",
                          arguments: "{not json",
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            };
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
      details: {
        category: "incompatible_response",
        name: "edit",
      },
    });
  });

  test("passes through derived JSON schemas as tools[i].function.parameters", async () => {
    const adapter = new OpenAICompatibleModelAdapter({
      model: "any-model",
      apiKey: "test-key",
    });

    const tool: RuntimeTool = {
      name: "echo",
      description: "echo input",
      inputSchema: z.object({ text: z.string() }).strict(),
      async execute() {
        return { ok: true, content: "" };
      },
    };
    const derivedSchema = getToolJsonSchema(tool);

    type CreateArgs = {
      tools: Array<{
        type: string;
        function: { name: string; description: string; parameters: unknown; strict?: boolean };
      }>;
      tool_choice?: unknown;
    };
    const createSpy = vi.fn(async (_args: CreateArgs) => ({
      id: "chatcmpl_ok",
      object: "chat.completion",
      choices: [
        {
          message: { content: "hi", tool_calls: undefined },
          finish_reason: "stop",
        },
      ],
    }));

    (adapter as unknown as { client: { chat: { completions: { create: typeof createSpy } } } }).client = {
      chat: { completions: { create: createSpy } },
    };

    await adapter.generate({
      systemPrompt: "You are a test.",
      messages: [],
      tools: [
        {
          name: tool.name,
          description: tool.description,
          inputSchema: derivedSchema,
        },
      ],
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    const callArgs = createSpy.mock.calls[0][0];
    expect(callArgs.tools).toHaveLength(1);
    expect(callArgs.tools[0].type).toBe("function");
    expect(callArgs.tools[0].function.name).toBe("echo");
    expect(callArgs.tools[0].function.description).toBe("echo input");
    expect(callArgs.tools[0].function.parameters).toEqual(derivedSchema);
    expect(callArgs.tools[0].function.strict).toBe(true);
  });

  test("omits tool_calls for assistant messages with an empty toolCalls array", async () => {
    // Regression: a final assistant message persisted with `toolCalls: []` must
    // not serialize to `tool_calls: []`, which the provider rejects with
    // "Expected an array with minimum length 1" on the next turn.
    const adapter = new OpenAICompatibleModelAdapter({ model: "any-model", apiKey: "test-key" });

    type CreateArgs = { messages: Array<Record<string, unknown>> };
    const createSpy = vi.fn(async (_args: CreateArgs) => ({
      id: "chatcmpl_ok",
      object: "chat.completion",
      choices: [{ message: { content: "ok", tool_calls: undefined }, finish_reason: "stop" }],
    }));
    (adapter as unknown as { client: { chat: { completions: { create: typeof createSpy } } } }).client = {
      chat: { completions: { create: createSpy } },
    };

    await adapter.generate({
      systemPrompt: "You are a test.",
      tools: [],
      messages: [
        { role: "user", content: "hi", messageId: "msg_1" },
        { role: "assistant", content: "prior answer", messageId: "msg_2", toolCalls: [] },
        { role: "user", content: "follow up", messageId: "msg_3" },
      ],
    });

    const sent = createSpy.mock.calls[0][0].messages;
    const assistant = sent.find((message) => message.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant).not.toHaveProperty("tool_calls");
  });

  test("does not read process.env.OPENAI_API_KEY when constructing the adapter", () => {
    // The env fallback used to live in the adapter; it now belongs to runtime/config.ts.
    // Setting OPENAI_API_KEY here ensures the OpenAI SDK can construct (it inspects env on its own),
    // but adapter.connection.apiKey must remain whatever was explicitly passed in (undefined).
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "env-only-key";
    try {
      const adapter = new OpenAICompatibleModelAdapter({ model: "any-model" });
      expect(adapter.connection.apiKey).toBeUndefined();
      expect(adapter.connection.provider).toBe("openai-compatible");
      expect(adapter.connection.model).toBe("any-model");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  test("streams multi-chunk text and completes with the assembled message", async () => {
    const adapter = new OpenAICompatibleModelAdapter({
      model: "any-model",
      apiKey: "test-key",
    });

    (adapter as unknown as { client: { chat: { completions: { create: () => Promise<AsyncIterable<unknown>> } } } }).client = {
      chat: {
        completions: {
          async create() {
            return chunks(
              { choices: [{ delta: { content: "hello " }, finish_reason: null }] },
              { choices: [{ delta: { content: "stream" }, finish_reason: "stop" }] },
            );
          },
        },
      },
    };

    const events = await collectStreamEvents(adapter.stream({
      systemPrompt: "You are a test.",
      messages: [],
      tools: [],
    }));

    const text = events
      .filter((event): event is Extract<ModelStreamEvent, { type: "text_delta" }> => event.type === "text_delta")
      .map((event) => event.text)
      .join("");
    const complete = events.at(-1);

    expect(text).toBe("hello stream");
    expect(complete).toMatchObject({
      type: "complete",
      result: {
        message: { content: "hello stream" },
        stopReason: "end_turn",
      },
    });
  });

  test("assembles split streamed tool calls and maps tool_calls finish reason", async () => {
    const adapter = new OpenAICompatibleModelAdapter({
      model: "any-model",
      apiKey: "test-key",
    });

    (adapter as unknown as { client: { chat: { completions: { create: () => Promise<AsyncIterable<unknown>> } } } }).client = {
      chat: {
        completions: {
          async create() {
            return chunks(
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_split",
                          type: "function",
                          function: { name: "read", arguments: "{\"path\":" },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          function: { arguments: "\"/tmp/a\"}" },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              },
            );
          },
        },
      },
    };

    const events = await collectStreamEvents(adapter.stream({
      systemPrompt: "You are a test.",
      messages: [],
      tools: [],
    }));
    const complete = events.at(-1);

    expect(complete).toMatchObject({
      type: "complete",
      result: {
        message: {
          toolCalls: [
            {
              id: "call_split",
              name: "read",
              arguments: { path: "/tmp/a" },
            },
          ],
        },
        stopReason: "tool_use",
      },
    });
  });

  test("captures trailing usage-only streamed chunks", async () => {
    const adapter = new OpenAICompatibleModelAdapter({
      model: "any-model",
      apiKey: "test-key",
    });

    (adapter as unknown as { client: { chat: { completions: { create: () => Promise<AsyncIterable<unknown>> } } } }).client = {
      chat: {
        completions: {
          async create() {
            return chunks(
              { choices: [{ delta: { content: "usage" }, finish_reason: "stop" }] },
              { choices: [], usage: { prompt_tokens: 7, completion_tokens: 11 } },
            );
          },
        },
      },
    };

    const events = await collectStreamEvents(adapter.stream({
      systemPrompt: "You are a test.",
      messages: [],
      tools: [],
    }));

    expect(events.at(-1)).toMatchObject({
      type: "complete",
      result: {
        usage: { inputTokens: 7, outputTokens: 11 },
      },
    });
  });

  test("maps provider errors thrown while starting a stream", async () => {
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
              request_id: string;
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
            error.request_id = "req_stream_429";
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
      collectStreamEvents(adapter.stream({
        systemPrompt: "You are a test.",
        messages: [],
        tools: [],
      })),
    ).rejects.toMatchObject({
      code: "MODEL_ERROR",
      retriable: true,
      details: {
        category: "quota",
        status: 429,
        provider: "Google AI Studio",
        providerStatus: "RESOURCE_EXHAUSTED",
        isByok: true,
        requestId: "req_stream_429",
      },
    });
  });

  test("rejects streamed tool calls whose accumulated arguments are invalid JSON", async () => {
    const adapter = new OpenAICompatibleModelAdapter({
      model: "any-model",
      apiKey: "test-key",
    });

    (adapter as unknown as { client: { chat: { completions: { create: () => Promise<AsyncIterable<unknown>> } } } }).client = {
      chat: {
        completions: {
          async create() {
            return chunks({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_bad_json",
                        type: "function",
                        function: { name: "edit", arguments: "{not json" },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            });
          },
        },
      },
    };

    await expect(
      collectStreamEvents(adapter.stream({
        systemPrompt: "You are a test.",
        messages: [],
        tools: [],
      })),
    ).rejects.toMatchObject({
      code: "MODEL_ERROR",
      details: {
        category: "incompatible_response",
        name: "edit",
      },
    });
  });

  test("generate() classifies an aborted request as RUN_ABORTED, not MODEL_ERROR", async () => {
    const adapter = new OpenAICompatibleModelAdapter({ model: "any-model", apiKey: "test-key" });
    (adapter as unknown as { client: { chat: { completions: { create: () => Promise<never> } } } }).client = {
      chat: {
        completions: {
          async create() {
            throw new Error("The operation was aborted");
          },
        },
      },
    };

    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter.generate({ systemPrompt: "You are a test.", messages: [], tools: [], signal: controller.signal }),
    ).rejects.toMatchObject({ code: "RUN_ABORTED" });
  });

  test("stream() classifies an aborted request as RUN_ABORTED, not MODEL_ERROR", async () => {
    const adapter = new OpenAICompatibleModelAdapter({ model: "any-model", apiKey: "test-key" });
    (adapter as unknown as { client: { chat: { completions: { create: () => Promise<never> } } } }).client = {
      chat: {
        completions: {
          async create() {
            throw new Error("The operation was aborted");
          },
        },
      },
    };

    const controller = new AbortController();
    controller.abort();

    await expect(
      collectStreamEvents(adapter.stream({ systemPrompt: "You are a test.", messages: [], tools: [], signal: controller.signal })),
    ).rejects.toMatchObject({ code: "RUN_ABORTED" });
  });
});
