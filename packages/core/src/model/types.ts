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

// Adapters yield provider deltas as they arrive, accumulate internally, then
// yield exactly one final `complete` event carrying the assembled GenerateResult,
// identical in shape and content to generate() for the same provider response.
// `complete` is always last; nothing may be yielded after it.
export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "complete"; result: GenerateResult };

export interface ModelAdapter {
  name: string;
  generate(input: GenerateInput): Promise<GenerateResult>;
  stream?(input: GenerateInput): AsyncIterable<ModelStreamEvent>;
}
