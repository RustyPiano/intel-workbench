import { RuntimeError } from "../runtime/errors.js";
import { OpenAICompatibleModelAdapter } from "./openai-compatible.js";
import type { ModelAdapter } from "./types.js";

export interface ModelFactoryOptions {
  provider: string;
  model: string;
  baseURL?: string;
  apiKey?: string;
}

export function createModelAdapter(options: ModelFactoryOptions): ModelAdapter {
  if (options.provider === "openai-compatible") {
    return new OpenAICompatibleModelAdapter(options);
  }

  throw new RuntimeError({
    code: "MODEL_ERROR",
    message: `Unsupported model provider: ${options.provider}`,
  });
}
