import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";

import { RuntimeError } from "../runtime/errors.js";
import type { AssistantMessage, RuntimeMessage, ToolCall } from "../runtime/types.js";
import type { GenerateInput, GenerateResult, ModelAdapter, ModelStreamEvent } from "./types.js";

export interface OpenAICompatibleModelAdapterOptions {
  provider?: string;
  apiKey?: string;
  model: string;
  baseURL?: string;
}

interface ProviderErrorShape {
  message?: string;
  code?: string | number;
  metadata?: {
    raw?: string;
    provider_name?: string;
    is_byok?: boolean;
  };
}

interface CompletionChoiceShape {
  message: {
    content: string | null;
    tool_calls?: ChatCompletionMessageToolCall[];
  };
  finish_reason: string | null;
}

function inferProviderErrorCategory(status: number | undefined, message: string): string {
  if (status === 401 || status === 403) {
    return "auth";
  }

  if (status === 429 || /resource_exhausted|quota|billing|credits/i.test(message)) {
    return "quota";
  }

  if (status === 400 && /model|unsupported/i.test(message)) {
    return "unsupported_model";
  }

  if (/network|fetch failed|econn|enotfound|timedout/i.test(message)) {
    return "network";
  }

  return "provider";
}

function extractRequestId(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidate = (error as { request_id?: unknown }).request_id;
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }

  const headers = (error as { headers?: unknown }).headers;
  if (headers && typeof headers === "object") {
    const headerValue = (headers as Record<string, unknown>)["x-request-id"];
    if (typeof headerValue === "string" && headerValue.length > 0) {
      return headerValue;
    }
  }

  return undefined;
}

function extractProviderError(error: unknown): RuntimeError {
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
  const providerError = (error as { error?: ProviderErrorShape })?.error;
  const providerName = providerError?.metadata?.provider_name;
  const raw = providerError?.metadata?.raw;

  let upstreamMessage: string | undefined;
  let upstreamStatus: string | undefined;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string; status?: string } };
      upstreamMessage = parsed.error?.message;
      upstreamStatus = parsed.error?.status;
    } catch {
      upstreamMessage = raw.trim();
    }
  }

  const fallbackMessage = error instanceof Error ? error.message : "Provider request failed";
  const effectiveProviderMessage = upstreamMessage ?? providerError?.message ?? fallbackMessage;
  const message = [providerName, effectiveProviderMessage].filter(Boolean).join(": ");
  const category = inferProviderErrorCategory(
    status,
    [providerError?.metadata?.raw, upstreamMessage, providerError?.message, fallbackMessage].filter(Boolean).join(" "),
  );
  const requestId = extractRequestId(error);

  return new RuntimeError({
    code: "MODEL_ERROR",
    message: status ? `${status} ${message}` : message,
    retriable: status === 429,
    details: {
      category,
      status,
      provider: providerName,
      providerCode: providerError?.code,
      providerStatus: upstreamStatus,
      isByok: providerError?.metadata?.is_byok,
      requestId,
    },
  });
}

function mapToolCall(toolCall: ChatCompletionMessageToolCall): ToolCall {
  if (toolCall.type !== "function") {
    throw new RuntimeError({
      code: "MODEL_ERROR",
      message: `Unsupported OpenAI-compatible tool call type: ${toolCall.type}`,
    });
  }

  const rawArguments: unknown = toolCall.function.arguments;

  if (typeof rawArguments === "string") {
    try {
      return {
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: JSON.parse(rawArguments) as Record<string, unknown>,
      };
    } catch (error) {
      throw new RuntimeError({
        code: "MODEL_ERROR",
        message: `Provider returned invalid tool arguments for ${toolCall.function.name}`,
        details: {
          category: "incompatible_response",
          name: toolCall.function.name,
          arguments: rawArguments,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  if (rawArguments !== null && typeof rawArguments === "object") {
    throw new RuntimeError({
      code: "MODEL_ERROR",
      message: "Provider returned tool call arguments as object instead of string",
      details: {
        category: "incompatible_response",
        name: toolCall.function.name,
      },
    });
  }

  throw new RuntimeError({
    code: "MODEL_ERROR",
    message: "Provider returned missing or invalid tool call arguments",
    details: {
      category: "incompatible_response",
      name: toolCall.function.name,
      argumentsType: typeof rawArguments,
    },
  });
}

function mapMessage(message: RuntimeMessage): ChatCompletionMessageParam {
  switch (message.role) {
    case "system":
      return {
        role: "system",
        content: message.content,
      };
    case "user":
      return {
        role: "user",
        content: message.content,
      };
    case "assistant": {
      const toolCalls = message.toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        type: "function" as const,
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments),
        },
      }));
      // Only include `tool_calls` when there is at least one. An empty array is
      // rejected by the provider ("Expected an array with minimum length 1").
      return {
        role: "assistant",
        content: message.content || null,
        ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
    }
    case "tool":
      if (!message.toolCallId) {
        throw new RuntimeError({
          code: "MODEL_ERROR",
          message: "Tool messages must include toolCallId",
        });
      }

      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId,
      };
    default:
      throw new RuntimeError({
        code: "MODEL_ERROR",
        message: `Unsupported message role: ${String((message as RuntimeMessage).role)}`,
      });
  }
}

function mapTools(input: GenerateInput): ChatCompletionTool[] {
  return input.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: true,
    },
  }));
}

function mapAssistantMessage(message: {
  content: string | null;
  tool_calls?: ChatCompletionMessageToolCall[];
}): AssistantMessage {
  return {
    role: "assistant",
    content: message.content ?? "",
    toolCalls: message.tool_calls?.map(mapToolCall),
  };
}

function mapStopReason(reason: string | null): GenerateResult["stopReason"] {
  if (reason === "tool_calls" || reason === "function_call") {
    return "tool_use";
  }

  if (reason === "length") {
    return "max_tokens";
  }

  return "end_turn";
}

function responseKeys(response: unknown): string[] | undefined {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return undefined;
  }

  return Object.keys(response);
}

function getFirstChoice(response: unknown): CompletionChoiceShape {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new RuntimeError({
      code: "MODEL_ERROR",
      message: "Provider returned malformed chat completion response: expected an object",
      details: {
        category: "incompatible_response",
        responseType: Array.isArray(response) ? "array" : typeof response,
      },
    });
  }

  const maybeChoices = (response as { choices?: unknown }).choices;
  if (!Array.isArray(maybeChoices)) {
    throw new RuntimeError({
      code: "MODEL_ERROR",
      message: "Provider returned malformed chat completion response: missing choices array",
      details: {
        category: "incompatible_response",
        responseKeys: responseKeys(response),
      },
    });
  }

  const choice = maybeChoices[0];
  if (!choice) {
    throw new RuntimeError({
      code: "MODEL_ERROR",
      message: "Provider returned no completion choices",
      details: {
        category: "incompatible_response",
      },
    });
  }

  const message = (choice as { message?: unknown }).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new RuntimeError({
      code: "MODEL_ERROR",
      message: "Provider returned malformed chat completion response: missing assistant message",
      details: {
        category: "incompatible_response",
        choiceKeys: responseKeys(choice),
      },
    });
  }

  return choice as CompletionChoiceShape;
}

export class OpenAICompatibleModelAdapter implements ModelAdapter {
  readonly name: string;
  readonly connection: Required<Pick<OpenAICompatibleModelAdapterOptions, "provider" | "model">> &
    Pick<OpenAICompatibleModelAdapterOptions, "baseURL" | "apiKey">;
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAICompatibleModelAdapterOptions) {
    this.name = options.model;
    this.connection = {
      provider: options.provider ?? "openai-compatible",
      model: options.model,
      baseURL: options.baseURL,
      apiKey: options.apiKey,
    };
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
    });
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    let response;
    try {
      response = await this.client.chat.completions.create({
        model: this.options.model,
        messages: [
          {
            role: "system",
            content: input.systemPrompt,
          },
          ...input.messages.map(mapMessage),
        ],
        tools: mapTools(input),
        tool_choice: input.tools.length ? "auto" : undefined,
        temperature: input.temperature,
        max_completion_tokens: input.maxTokens,
      }, {
        signal: input.signal,
      });
    } catch (error) {
      throw extractProviderError(error);
    }

    const choice = getFirstChoice(response);

    return {
      message: mapAssistantMessage(choice.message),
      stopReason: mapStopReason(choice.finish_reason),
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
          }
        : undefined,
      rawResponse: response,
    };
  }

  async *stream(input: GenerateInput): AsyncIterable<ModelStreamEvent> {
    let content = "";
    const toolCalls = new Map<number, { id?: string; name?: string; args: string }>();
    let finishReason: ChatCompletionChunk.Choice["finish_reason"] = null;
    let usage: ChatCompletionChunk["usage"];

    try {
      const stream = await this.client.chat.completions.create({
        model: this.options.model,
        messages: [
          {
            role: "system",
            content: input.systemPrompt,
          },
          ...input.messages.map(mapMessage),
        ],
        tools: mapTools(input),
        tool_choice: input.tools.length ? "auto" : undefined,
        temperature: input.temperature,
        max_completion_tokens: input.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }, {
        signal: input.signal,
      });

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        const text = choice?.delta?.content;
        if (typeof text === "string" && text.length > 0) {
          content += text;
          yield { type: "text_delta", text };
        }

        for (const toolCall of choice?.delta?.tool_calls ?? []) {
          const entry = toolCalls.get(toolCall.index) ?? { args: "" };
          const name = toolCall.function?.name;
          const argumentsDelta = toolCall.function?.arguments;

          if (toolCall.id !== undefined) {
            entry.id = toolCall.id;
          }
          if (name !== undefined) {
            entry.name = name;
          }
          if (argumentsDelta !== undefined) {
            entry.args += argumentsDelta;
          }

          toolCalls.set(toolCall.index, entry);
          yield {
            type: "tool_call_delta",
            index: toolCall.index,
            ...(toolCall.id !== undefined ? { id: toolCall.id } : {}),
            ...(name !== undefined ? { name } : {}),
            ...(argumentsDelta !== undefined ? { argumentsDelta } : {}),
          };
        }

        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }
        if (chunk.usage) {
          usage = chunk.usage;
        }
      }
    } catch (error) {
      throw extractProviderError(error);
    }

    const assembledToolCalls: ChatCompletionMessageToolCall[] = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, entry]) => {
        if (!entry.id || !entry.name) {
          throw new RuntimeError({
            code: "MODEL_ERROR",
            message: "Provider streamed a tool call without id/name",
            details: { category: "incompatible_response" },
          });
        }

        return {
          id: entry.id,
          type: "function",
          function: {
            name: entry.name,
            arguments: entry.args,
          },
        };
      });

    const message = mapAssistantMessage({
      content: content.length ? content : null,
      tool_calls: assembledToolCalls.length ? assembledToolCalls : undefined,
    });

    yield {
      type: "complete",
      result: {
        message,
        stopReason: mapStopReason(finishReason),
        usage: usage
          ? {
              inputTokens: usage.prompt_tokens,
              outputTokens: usage.completion_tokens,
            }
          : undefined,
      },
    };
  }
}
