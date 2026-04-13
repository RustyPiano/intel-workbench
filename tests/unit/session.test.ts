import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { SessionStore } from "../../src/runtime/session.js";

const tempRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-"));
  tempRoots.push(root);
  return root;
}

describe("SessionStore", () => {
  test("creates a jsonl session with a header and appended entries", async () => {
    const workspaceRoot = await createWorkspace();
    const store = new SessionStore({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      model: "mock",
    });

    const session = await store.createSession();
    await store.appendEntry(session.sessionId, {
      type: "message",
      role: "user",
      messageId: "msg_1",
      timestamp: "2026-04-13T00:00:00.000Z",
      content: "hello",
    });

    const content = await readFile(session.path, "utf8");
    const lines = content.trim().split("\n");

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      type: "session_header",
      sessionId: session.sessionId,
      workspaceRoot,
      model: "mock",
    });
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
      type: "message",
      role: "user",
      content: "hello",
    });
  });

  test("marks a corrupted session and writes a repair report", async () => {
    const workspaceRoot = await createWorkspace();
    const store = new SessionStore({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      model: "mock",
    });
    const session = await store.createSession("sess_corrupted");
    const { appendFile } = await import("node:fs/promises");

    await appendFile(
      session.path,
      `{"type":"tool_result","toolCallId":"missing","ok":true,"content":"oops","timestamp":"2026-04-13T00:00:01.000Z"}\n`,
    );

    const loaded = await store.loadSession(session.sessionId);

    expect(loaded.corrupted).toBe(true);
    expect(loaded.repairReportPath).toBeTruthy();
    expect(loaded.entries).toHaveLength(1);
    const report = await readFile(loaded.repairReportPath!, "utf8");
    expect(report).toContain("missing matching tool_call");
  });

  test("round-trips generated session ids across store instances", async () => {
    const workspaceRoot = await createWorkspace();
    const store = new SessionStore({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      model: "mock",
    });

    const created = await store.createSession();

    const reopenedStore = new SessionStore({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      model: "mock",
    });
    const listed = await reopenedStore.listSessions();

    expect(listed[0]?.sessionId).toBe(created.sessionId);
    const loaded = await reopenedStore.loadSession(created.sessionId);
    expect(loaded.header?.sessionId).toBe(created.sessionId);
  });

  test("marks out-of-order tool events as corrupted", async () => {
    const workspaceRoot = await createWorkspace();
    const store = new SessionStore({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      model: "mock",
    });
    const session = await store.createSession("sess_out_of_order");
    const { appendFile } = await import("node:fs/promises");

    await appendFile(
      session.path,
      `${JSON.stringify({
        type: "message",
        role: "assistant",
        messageId: "msg_assistant",
        timestamp: "2026-04-13T00:00:00.000Z",
        content: "I will use a tool.",
        toolCalls: [{ id: "call_read", name: "read", arguments: { path: "README.md" } }],
      })}\n`,
    );
    await appendFile(
      session.path,
      `${JSON.stringify({
        type: "message",
        role: "user",
        messageId: "msg_user",
        timestamp: "2026-04-13T00:00:01.000Z",
        content: "This should not come before the tool call.",
      })}\n`,
    );

    const loaded = await store.loadSession(session.sessionId);

    expect(loaded.corrupted).toBe(true);
    const report = await readFile(loaded.repairReportPath!, "utf8");
    expect(report).toContain("pending tool calls completed");
  });

  test("marks assistant turns inserted before tool completion as corrupted", async () => {
    const workspaceRoot = await createWorkspace();
    const store = new SessionStore({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      model: "mock",
    });
    const session = await store.createSession("sess_assistant_out_of_order");
    const { appendFile } = await import("node:fs/promises");

    await appendFile(
      session.path,
      `${JSON.stringify({
        type: "message",
        role: "assistant",
        messageId: "msg_assistant_1",
        timestamp: "2026-04-13T00:00:00.000Z",
        content: "I will use a tool.",
        toolCalls: [{ id: "call_read", name: "read", arguments: { path: "README.md" } }],
      })}\n`,
    );
    await appendFile(
      session.path,
      `${JSON.stringify({
        type: "message",
        role: "assistant",
        messageId: "msg_assistant_2",
        timestamp: "2026-04-13T00:00:01.000Z",
        content: "This should not come before the tool completes.",
      })}\n`,
    );

    const loaded = await store.loadSession(session.sessionId);

    expect(loaded.corrupted).toBe(true);
    const report = await readFile(loaded.repairReportPath!, "utf8");
    expect(report).toContain("assistant message appears before pending tool calls completed");
  });
});
