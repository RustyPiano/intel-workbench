import type { AssistantMessage, RuntimeMessage } from "../runtime/types.js";
import type { JsonSchema } from "../tools/types.js";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface GenerateInput {
  systemPrompt: string;
  messages: RuntimeMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
}

export interface GenerateResult {
  message: AssistantMessage;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "error";
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  rawResponse?: unknown;
}

export interface ModelAdapter {
  name: string;
  generate(input: GenerateInput): Promise<GenerateResult>;
  stream?(input: GenerateInput): AsyncIterable<unknown>;
}
