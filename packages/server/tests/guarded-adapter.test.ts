import type { GenerateInput, GenerateResult, ModelAdapter, ModelStreamEvent } from "mini-agent";
import { describe, expect, it } from "vitest";

import { AppError } from "../src/domain/identity.js";
import { guardModelAdapter } from "../src/security/guarded-adapter.js";
import type { OfflineGuard } from "../src/security/offline-guard.js";

function final(content: string): GenerateResult {
  return { message: { role: "assistant", content }, stopReason: "end_turn" };
}

describe("guardModelAdapter stream", () => {
  it("authorizes once before delegating stream chunks", async () => {
    const calls: string[] = [];
    const guard = {
      async authorize() {
        calls.push("authorize");
      },
    } as unknown as OfflineGuard;
    const inner: ModelAdapter = {
      name: "inner",
      async generate() {
        return final("unused");
      },
      async *stream(_input: GenerateInput): AsyncIterable<ModelStreamEvent> {
        calls.push("stream-start");
        yield { type: "text_delta", text: "A" };
        yield { type: "complete", result: final("A") };
      },
    };

    const guarded = guardModelAdapter(inner, guard, { endpoint: "https://stub.local/v1", user: "op", purpose: "text" });
    const iterator = guarded.stream!({ systemPrompt: "", messages: [], tools: [] })[Symbol.asyncIterator]();

    const first = await iterator.next();

    expect(calls).toEqual(["authorize", "stream-start"]);
    expect(first.value).toEqual({ type: "text_delta", text: "A" });
    await iterator.return?.();
  });

  it("throws AppError 503 on first stream iteration when endpoint is empty", async () => {
    const guard = {
      async authorize() {
        throw new Error("must not authorize without endpoint");
      },
    } as unknown as OfflineGuard;
    const inner: ModelAdapter = {
      name: "inner",
      async generate() {
        return final("unused");
      },
      async *stream(): AsyncIterable<ModelStreamEvent> {
        yield { type: "complete", result: final("unused") };
      },
    };

    const guarded = guardModelAdapter(inner, guard, { endpoint: "", user: "op", purpose: "text" });

    await expect(guarded.stream!({ systemPrompt: "", messages: [], tools: [] })[Symbol.asyncIterator]().next())
      .rejects.toBeInstanceOf(AppError);
    await expect(guarded.stream!({ systemPrompt: "", messages: [], tools: [] })[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ status: 503 });
  });

  it("omits stream when the inner adapter has no stream implementation", () => {
    const guard = {
      async authorize() {},
    } as unknown as OfflineGuard;
    const inner: ModelAdapter = {
      name: "inner",
      async generate() {
        return final("fallback");
      },
    };

    const guarded = guardModelAdapter(inner, guard, { endpoint: "https://stub.local/v1", user: "op", purpose: "text" });

    expect(typeof guarded.stream).toBe("undefined");
  });
});
