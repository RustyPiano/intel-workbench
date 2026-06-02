import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { RuntimeAgent } from "../../src/runtime/agent.js";
import { formatToolMessageContent } from "../../src/runtime/loop.js";
import { ScriptedModelAdapter } from "../../src/model/mock.js";
import type { ToolExecutionResult } from "../../src/tools/types.js";
import type { RuntimeMessage, ToolResultEntry } from "../../src/runtime/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-agent-unit-"));
  tempRoots.push(root);
  return root;
}

function quietModel(responses = 8): ScriptedModelAdapter {
  return new ScriptedModelAdapter(
    Array.from({ length: responses }).map(() => ({
      message: { role: "assistant" as const, content: "ok" },
      stopReason: "end_turn" as const,
    })),
  );
}

describe("RuntimeAgent.create (static factory)", () => {
  test("returns an agent with a discovered SkillRegistry and a real PolicyEngine", async () => {
    const workspaceRoot = await createWorkspace();
    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: quietModel(1),
    });

    expect(agent.skillRegistry).toBeDefined();
    // A real, discovered SkillRegistry exposes a catalog method (empty in
    // workspaces without skills).
    expect(typeof agent.skillRegistry.getCatalog).toBe("function");
    expect(Array.isArray(agent.skillRegistry.getCatalog())).toBe(true);

    // The policy engine should be bound to the resolved workspace root, not
    // the previous "." placeholder. A path outside the workspace must be
    // rejected.
    expect(() => agent.policy.resolveWritePath("/etc/passwd")).toThrow();
  });

  test("defaults the agent turn budget to 30", async () => {
    const workspaceRoot = await createWorkspace();
    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: quietModel(1),
    });

    expect(agent.maxTurns).toBe(30);
  });

  test("createConversation() without sessionId creates a fresh session", async () => {
    const workspaceRoot = await createWorkspace();
    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: quietModel(1),
    });

    const conversation = await agent.createConversation();
    expect(conversation.sessionId).toMatch(/^sess_/);

    const sessions = await agent.sessionStore.listSessions();
    expect(sessions.some((session) => session.sessionId === conversation.sessionId)).toBe(true);
  });

  test("createConversation(unknownId) throws SESSION_NOT_FOUND", async () => {
    const workspaceRoot = await createWorkspace();
    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: quietModel(1),
    });

    await expect(agent.createConversation("sess_does_not_exist")).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
  });

  test("createConversation(unknownId, { createIfMissing: true }) creates a session with that id", async () => {
    const workspaceRoot = await createWorkspace();
    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: quietModel(1),
    });

    const conversation = await agent.createConversation("my-named-session", { createIfMissing: true });
    expect(conversation.sessionId).toBe("my-named-session");

    const sessions = await agent.sessionStore.listSessions();
    expect(sessions.some((session) => session.sessionId === "my-named-session")).toBe(true);

    // Resuming the same id reuses the existing session rather than forking.
    const resumed = await agent.createConversation("my-named-session", { createIfMissing: true });
    expect(resumed.sessionId).toBe("my-named-session");
    const afterResume = await agent.sessionStore.listSessions();
    expect(afterResume.filter((session) => session.sessionId === "my-named-session")).toHaveLength(1);
  });
});

describe("RuntimeConversation.send concurrency", () => {
  test("serializes overlapping send() invocations", async () => {
    const workspaceRoot = await createWorkspace();
    const responses = Array.from({ length: 5 }).map((_, index) => ({
      message: { role: "assistant" as const, content: `reply-${index}` },
      stopReason: "end_turn" as const,
    }));
    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: new ScriptedModelAdapter(responses),
    });

    const conversation = await agent.createConversation();
    const prompts = ["one", "two", "three", "four", "five"];
    const results = await Promise.all(prompts.map((prompt) => conversation.send(prompt)));

    // Final messages came back in the order they were submitted.
    expect(results.map((result) => result.finalMessage.content)).toEqual([
      "reply-0",
      "reply-1",
      "reply-2",
      "reply-3",
      "reply-4",
    ]);

    const loaded = await agent.sessionStore.loadSession(conversation.sessionId);
    const messageOrder = loaded.entries
      .filter((entry): entry is Extract<typeof entry, { type: "message" }> => entry.type === "message")
      .map((entry) => entry.content);

    // Each user prompt should appear once, in submission order, and each must
    // be followed by its matching assistant reply (no interleaving).
    expect(messageOrder).toEqual([
      "one",
      "reply-0",
      "two",
      "reply-1",
      "three",
      "reply-2",
      "four",
      "reply-3",
      "five",
      "reply-4",
    ]);
  });

  test("a failed send does not poison the queue", async () => {
    const workspaceRoot = await createWorkspace();
    let callCount = 0;
    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: {
        name: "mock",
        async generate() {
          callCount += 1;
          if (callCount === 1) {
            throw new Error("first send failed");
          }
          return {
            message: { role: "assistant", content: "recovered" },
            stopReason: "end_turn",
          };
        },
      },
    });

    const conversation = await agent.createConversation();
    const first = conversation.send("first");
    const second = conversation.send("second");

    await expect(first).rejects.toThrow("first send failed");
    const secondResult = await second;
    expect(secondResult.finalMessage.content).toBe("recovered");
  });
});

describe("resume repairs interrupted tool calls", () => {
  test("synthesizes a tool result for an assistant tool_call left unanswered by a crashed run", async () => {
    const workspaceRoot = await createWorkspace();
    const capturedMessages: RuntimeMessage[][] = [];
    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: {
        name: "mock",
        async generate(input) {
          capturedMessages.push(input.messages);
          return { message: { role: "assistant", content: "resumed ok" }, stopReason: "end_turn" };
        },
      },
    });

    // Build a session that was interrupted between the tool-call request and its
    // result: assistant asks for `call_x`, the tool_call is recorded, but the
    // process died before any tool_result was written.
    const ts = "2026-01-01T00:00:00.000Z";
    const session = await agent.sessionStore.createSession();
    await agent.sessionStore.appendEntry(session.sessionId, {
      type: "message",
      role: "user",
      messageId: "m1",
      timestamp: ts,
      content: "read the file",
    });
    await agent.sessionStore.appendEntry(session.sessionId, {
      type: "message",
      role: "assistant",
      messageId: "m2",
      timestamp: ts,
      content: "",
      toolCalls: [{ id: "call_x", name: "read", arguments: { path: "x.txt" } }],
    });
    await agent.sessionStore.appendEntry(session.sessionId, {
      type: "tool_call",
      toolCallId: "call_x",
      toolName: "read",
      args: { path: "x.txt" },
      timestamp: ts,
    });

    const conversation = await agent.createConversation(session.sessionId);
    const result = await conversation.send("continue");
    expect(result.finalMessage.content).toBe("resumed ok");

    // The messages handed to the provider must answer every tool_call id.
    const sent = capturedMessages[0]!;
    for (const message of sent) {
      if (message.role === "assistant" && message.toolCalls) {
        for (const toolCall of message.toolCalls) {
          expect(sent.some((other) => other.role === "tool" && other.toolCallId === toolCall.id)).toBe(true);
        }
      }
    }
    const synthetic = sent.find((message) => message.role === "tool" && message.toolCallId === "call_x");
    expect(synthetic).toBeDefined();
    expect(synthetic!.content).toContain("interrupted");
  });
});

describe("formatToolMessageContent (live <-> replay parity)", () => {
  function replayContent(result: ToolExecutionResult): string {
    // Mimic agent.ts:replayMessages reconstructing a ToolExecutionResult from
    // a persisted ToolResultEntry, then re-serializing via the same helper.
    const entry: ToolResultEntry = {
      type: "tool_result",
      toolCallId: "call_test",
      ok: result.ok,
      content: result.content,
      timestamp: "2026-01-01T00:00:00.000Z",
      meta:
        typeof result.meta === "object" && result.meta !== null
          ? (result.meta as Record<string, unknown>)
          : undefined,
      error: result.error,
    };
    const reconstructed: ToolExecutionResult = {
      ok: entry.ok,
      content: entry.content,
      meta: entry.meta ?? entry.data,
      error: entry.error,
    };
    return formatToolMessageContent(reconstructed);
  }

  test("produces byte-identical output for live and replay paths (success result, no artifacts)", () => {
    const result: ToolExecutionResult = {
      ok: true,
      content: "hello\nworld",
      meta: { bytes_written: 11, path: "/tmp/foo.txt" },
    };

    const live = formatToolMessageContent(result);
    expect(live).toBe(replayContent(result));
  });

  test("produces byte-identical output for failure results", () => {
    const result: ToolExecutionResult = {
      ok: false,
      content: "tool failed",
      error: { code: "TOOL_TIMEOUT", message: "timed out" },
    };

    const live = formatToolMessageContent(result);
    expect(live).toBe(replayContent(result));
  });

  test("omits undefined optional fields (legacy session compatibility)", () => {
    const minimal: ToolExecutionResult = { ok: true, content: "ok" };
    expect(formatToolMessageContent(minimal)).toBe('{"ok":true,"content":"ok"}');
  });

  test("preserves declared key order: ok, content, meta, error, artifacts", () => {
    const result: ToolExecutionResult = {
      ok: false,
      content: "",
      meta: { kind: "demo" },
      error: { code: "INTERNAL_ERROR", message: "boom" },
      artifacts: [{ type: "log", path: "/tmp/x.log" }],
    };

    const encoded = formatToolMessageContent(result);
    expect(encoded.indexOf('"ok"')).toBeLessThan(encoded.indexOf('"content"'));
    expect(encoded.indexOf('"content"')).toBeLessThan(encoded.indexOf('"meta"'));
    expect(encoded.indexOf('"meta"')).toBeLessThan(encoded.indexOf('"error"'));
    expect(encoded.indexOf('"error"')).toBeLessThan(encoded.indexOf('"artifacts"'));
  });
});

describe("loop maxTurns handling", () => {
  test("returns a user-confirmation handoff instead of failing when the limit is reached", async () => {
    const workspaceRoot = await createWorkspace();
    // Each model response keeps requesting a tool call so the loop never finds
    // a natural stopping point and must bail on the turn budget. We use the
    // built-in `read` tool against a real file so the executor stays happy.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(workspaceRoot, "loop.txt"), "x\n", "utf8");

    const responses = Array.from({ length: 6 }).map((_, index) => ({
      message: {
        role: "assistant" as const,
        content: `turn ${index}`,
        toolCalls: [{ id: `call_${index}`, name: "read", arguments: { path: "loop.txt" } }],
      },
      stopReason: "tool_use" as const,
    }));

    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: new ScriptedModelAdapter(responses),
      maxTurns: 3,
    });

    const result = await agent.run("loop forever");

    expect(result.finalMessage.content).toContain("已达到本次运行的最大轮数");
    expect(result.finalMessage.content).toContain("继续");

    const sessions = await agent.sessionStore.listSessions();
    expect(sessions).toHaveLength(1);
    const loaded = await agent.sessionStore.loadSession(sessions[0]!.sessionId);
    expect(loaded.entries.some((entry) => entry.type === "error")).toBe(false);
    expect(loaded.entries.at(-1)).toMatchObject({
      type: "message",
      role: "assistant",
      content: expect.stringContaining("已达到本次运行的最大轮数"),
    });

    const runs = await agent.runStore.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("completed");
    expect(runs[0]!.first_error_code).toBeUndefined();

    const trace = await agent.runStore.loadTrace(result.runId);
    expect(trace.events.some((event) => event.type === "turn_limit_reached")).toBe(true);
  });
});
