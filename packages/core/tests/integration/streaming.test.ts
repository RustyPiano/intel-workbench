import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { ScriptedModelAdapter } from "../../src/model/mock.js";
import type { GenerateInput, GenerateResult, ModelAdapter, ModelStreamEvent } from "../../src/model/types.js";
import { RuntimeAgent } from "../../src/runtime/agent.js";
import { RuntimeError } from "../../src/runtime/errors.js";
import type { RuntimeTool } from "../../src/tools/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-streaming-"));
  tempRoots.push(root);
  return root;
}

async function createAgent(modelAdapter: ModelAdapter): Promise<RuntimeAgent> {
  return RuntimeAgent.create({
    workspaceRoot: await createWorkspace(),
    runtimeVersion: "1.0.0",
    modelName: "mock",
    modelAdapter,
  });
}

function scriptedFinal(content = "done"): GenerateResult {
  return {
    message: { role: "assistant", content },
    stopReason: "end_turn",
  };
}

function scriptedToolCall(name: string, args: Record<string, unknown>, id = `call_${name}`): GenerateResult {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id, name, arguments: args }],
    },
    stopReason: "tool_use",
  };
}

function customTool(name: string, execute: RuntimeTool["execute"]): RuntimeTool {
  return {
    name,
    description: `${name} fixture`,
    inputSchema: z.object({ value: z.string().optional() }).strict(),
    execute,
  };
}

async function sessionMessages(agent: RuntimeAgent, sessionId: string) {
  const loaded = await agent.sessionStore.loadSession(sessionId);
  return loaded.entries
    .filter((entry): entry is Extract<typeof entry, { type: "message" }> => entry.type === "message")
    .map((entry) => ({
      role: entry.role,
      content: entry.content,
      toolCalls: entry.toolCalls,
    }));
}

describe("runtime model streaming", () => {
  test("streaming and non-streaming runs record equivalent final messages and session messages", async () => {
    const response = scriptedFinal("identical final content");
    const streamingAgent = await createAgent(new ScriptedModelAdapter([response], 4));
    const nonStreamingAgent = await createAgent(new ScriptedModelAdapter([response], 4));
    const streamingEvents: ModelStreamEvent[] = [];

    const streaming = await streamingAgent.run("same prompt", undefined, {
      onModelStreamEvent: (event) => streamingEvents.push(event),
    });
    const nonStreaming = await nonStreamingAgent.run("same prompt");

    expect(streaming.finalMessage.content).toBe(nonStreaming.finalMessage.content);
    expect(await sessionMessages(streamingAgent, streaming.sessionId)).toEqual(
      await sessionMessages(nonStreamingAgent, nonStreaming.sessionId),
    );
    expect(streamingEvents.some((event) => event.type === "text_delta")).toBe(true);
  });

  test("forwards ordered text deltas from scripted streaming", async () => {
    const content = "stream these characters in order";
    const model = new ScriptedModelAdapter([scriptedFinal(content)], 5);
    const agent = await createAgent(model);
    const events: ModelStreamEvent[] = [];

    await agent.run("stream text", undefined, {
      onModelStreamEvent: (event) => events.push(event),
    });

    const textDeltas = events.filter((event): event is Extract<ModelStreamEvent, { type: "text_delta" }> => event.type === "text_delta");
    expect(textDeltas).toHaveLength(Math.ceil(content.length / 5));
    expect(textDeltas.map((event) => event.text).join("")).toBe(content);
  });

  test("assembles streamed tool calls, runs the tool, and continues to the final streamed turn", async () => {
    const callId = "call_custom_stream";
    const finalText = "tool finished";
    let ran = false;
    const model = new ScriptedModelAdapter([
      scriptedToolCall("custom_stream", { value: "hello" }, callId),
      scriptedFinal(finalText),
    ]);
    const agent = await createAgent(model);
    const events: ModelStreamEvent[] = [];

    const result = await agent.run("call streamed tool", undefined, {
      extraTools: [
        customTool("custom_stream", async () => {
          ran = true;
          return { ok: true, content: "custom ok" };
        }),
      ],
      onModelStreamEvent: (event) => events.push(event),
    });

    const loaded = await agent.sessionStore.loadSession(result.sessionId);
    expect(ran).toBe(true);
    expect(result.finalMessage.content).toBe(finalText);
    expect(
      loaded.entries.some((entry) => entry.type === "tool_result" && entry.toolCallId === callId && entry.ok),
    ).toBe(true);
    expect(events).toContainEqual({
      type: "tool_call_delta",
      index: 0,
      id: callId,
      name: "custom_stream",
      argumentsDelta: JSON.stringify({ value: "hello" }),
    });
  });

  test("falls back to generate when a sink is provided but the adapter has no stream method", async () => {
    const response = scriptedFinal("fallback result");
    let sinkCalls = 0;
    const adapter: ModelAdapter = {
      name: "generate-only",
      async generate() {
        return response;
      },
    };
    const agent = await createAgent(adapter);

    const result = await agent.run("fallback", undefined, {
      onModelStreamEvent: () => {
        sinkCalls += 1;
      },
    });

    expect(result.finalMessage.content).toBe(response.message.content);
    expect(sinkCalls).toBe(0);
  });

  test("uses generate by default even when the adapter exposes stream", async () => {
    class ThrowingStreamAdapter extends ScriptedModelAdapter {
      override async *stream(): AsyncIterable<ModelStreamEvent> {
        throw new Error("stream should not be called without a sink");
      }
    }
    const agent = await createAgent(new ThrowingStreamAdapter([scriptedFinal("generate path")]));

    const result = await agent.run("default path");

    expect(result.finalMessage.content).toBe("generate path");
  });

  test("rejects and journals MODEL_ERROR when a stream ends without complete", async () => {
    const adapter: ModelAdapter = {
      name: "incomplete-stream",
      async generate() {
        return scriptedFinal("unused");
      },
      async *stream() {
        yield { type: "text_delta", text: "partial" };
      },
    };
    const agent = await createAgent(adapter);
    const conversation = await agent.createConversation();

    await expect(
      conversation.send("missing complete", undefined, {
        onModelStreamEvent: () => {},
      }),
    ).rejects.toMatchObject({
      code: "MODEL_ERROR",
    });

    const loaded = await agent.sessionStore.loadSession(conversation.sessionId);
    expect(loaded.entries.some((entry) => entry.type === "error" && entry.error.code === "MODEL_ERROR")).toBe(true);
  });

  test("rejects and journals RUN_ABORTED when a stream observes an aborted signal", async () => {
    const controller = new AbortController();
    const adapter: ModelAdapter = {
      name: "abort-stream",
      async generate() {
        return scriptedFinal("unused");
      },
      async *stream(input: GenerateInput) {
        yield { type: "text_delta", text: "partial" };
        controller.abort(new Error("stop streaming"));
        if (input.signal?.aborted) {
          throw new RuntimeError({ code: "RUN_ABORTED", message: "Run aborted by signal", retriable: true });
        }
      },
    };
    const agent = await createAgent(adapter);
    const conversation = await agent.createConversation();

    await expect(
      conversation.send("abort", controller.signal, {
        onModelStreamEvent: () => {},
      }),
    ).rejects.toMatchObject({
      code: "RUN_ABORTED",
    });

    const loaded = await agent.sessionStore.loadSession(conversation.sessionId);
    expect(loaded.entries.some((entry) => entry.type === "error" && entry.error.code === "RUN_ABORTED")).toBe(true);
  });

  test("captures deltas from both turns of a multi-turn streamed run", async () => {
    const finalText = "second streamed turn";
    const model = new ScriptedModelAdapter([
      scriptedToolCall("custom_multi", { value: "first" }, "call_multi"),
      scriptedFinal(finalText),
    ], 3);
    const agent = await createAgent(model);
    const events: ModelStreamEvent[] = [];

    const result = await agent.run("multi-turn", undefined, {
      extraTools: [
        customTool("custom_multi", async () => ({ ok: true, content: "multi ok" })),
      ],
      onModelStreamEvent: (event) => events.push(event),
    });

    expect(result.finalMessage.content).toBe(finalText);
    expect(events.some((event) => event.type === "tool_call_delta" && event.name === "custom_multi")).toBe(true);
    expect(
      events
        .filter((event): event is Extract<ModelStreamEvent, { type: "text_delta" }> => event.type === "text_delta")
        .map((event) => event.text)
        .join(""),
    ).toBe(finalText);
  });
});
