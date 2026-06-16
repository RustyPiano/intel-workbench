import type { GenerateInput, ModelAdapter, ModelStreamEvent } from "mini-agent";

import { AppError } from "../domain/identity.js";
import type { OfflineGuard } from "./offline-guard.js";

export function guardModelAdapter(
  inner: ModelAdapter,
  guard: OfflineGuard,
  ctx: { endpoint: string; user: string; purpose: string },
): ModelAdapter {
  return {
    name: inner.name,
    async generate(input) {
      if (!ctx.endpoint) {
        throw new AppError(503, "文本 LLM 端点未配置：禁止 real 出站（零外发）");
      }
      await guard.authorize(ctx.endpoint, { user: ctx.user, purpose: ctx.purpose });
      return inner.generate(input);
    },
    ...(inner.stream
      ? {
          async *stream(input: GenerateInput): AsyncIterable<ModelStreamEvent> {
            if (!ctx.endpoint) {
              throw new AppError(503, "文本 LLM 端点未配置：禁止 real 出站（零外发）");
            }
            await guard.authorize(ctx.endpoint, { user: ctx.user, purpose: ctx.purpose });
            yield* inner.stream!(input);
          },
        }
      : {}),
  };
}
