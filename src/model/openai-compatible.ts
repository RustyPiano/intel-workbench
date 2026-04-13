import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";

import { RuntimeError } from "../runtime/errors.js";
import type { AssistantMessage, RuntimeMessage, ToolCall } from "../runtime/types.js";
import type { GenerateInput, GenerateResult, ModelAdapter } from "./types.js";

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

  try {
    return {
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: JSON.parse(toolCall.function.arguments) as Record<string, unknown>,
    };
  } catch (error) {
    throw new RuntimeError({
      code: "MODEL_ERROR",
      message: `Provider returned invalid tool arguments for ${toolCall.function.name}`,
      details: {
        arguments: toolCall.function.arguments,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
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
    case "assistant":
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls?.map((toolCall) => ({
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          },
        })),
      };
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
      apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
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

    const choice = response.choices[0];
    if (!choice) {
      throw new RuntimeError({
        code: "MODEL_ERROR",
        message: "Provider returned no completion choices",
      });
    }

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
}
