import { access, mkdir, mkdtemp, readFile, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { SessionStore, toFileSafeIso } from "../../src/runtime/session.js";
import { RuntimeError } from "../../src/runtime/errors.js";

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
  test("serializes independent stores on the same session lock", async () => {
    const workspaceRoot = await createWorkspace();
    const options = {
      workspaceRoot,
      runtimeVersion: "1.0.0",
      model: "mock",
      sessionLockPollMs: 5,
    };
    const firstStore = new SessionStore(options);
    const secondStore = new SessionStore(options);
    let release!: () => void;
    let markEntered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let secondEntered = false;
    const first = firstStore.withSessionLock("shared", async () => {
      markEntered();
      await gate;
    });
    await entered;
    const second = secondStore.withSessionLock("shared", async () => {
      secondEntered = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondEntered).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
  });

  test("only clears dead-owner or expired ownerless locks", async () => {
    const workspaceRoot = await createWorkspace();
    const sessionDir = path.join(workspaceRoot, ".mini-agent", "sessions");
    await mkdir(sessionDir, { recursive: true });
    const store = new SessionStore({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      model: "mock",
      sessionLockPollMs: 5,
      sessionLockStaleMs: 10,
    });

    const deadLock = path.join(sessionDir, ".dead.lock");
    await writeFile(deadLock, JSON.stringify({ token: "dead", pid: 99_999_999, createdAt: new Date().toISOString() }));
    await store.withSessionLock("dead", async () => {});
    await expect(access(deadLock)).rejects.toThrow();

    const damagedLock = path.join(sessionDir, ".damaged.lock");
    await writeFile(damagedLock, "not-json");
    const old = new Date(Date.now() - 1_000);
    await utimes(damagedLock, old, old);
    await store.withSessionLock("damaged", async () => {});
    await expect(access(damagedLock)).rejects.toThrow();

    const liveLock = path.join(sessionDir, ".live.lock");
    await writeFile(liveLock, JSON.stringify({ token: "live", pid: process.pid, createdAt: old.toISOString() }));
    await utimes(liveLock, old, old);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(store.withSessionLock("live", async () => {}, controller.signal)).rejects.toMatchObject({
      code: "RUN_ABORTED",
    });
    await expect(access(liveLock)).resolves.toBeUndefined();
    await unlink(liveLock);
  });

  test("rejects session ids that could escape the session directory", async () => {
    const workspaceRoot = await createWorkspace();
    const store = new SessionStore({ workspaceRoot, runtimeVersion: "1.0.0", model: "mock" });

    await expect(store.createSession("x/../../../escaped")).rejects.toMatchObject({ code: "INVALID_ARGS" });
  });

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

    expect(loaded.status).toBe("corrupted");
    expect(loaded.corrupted).toBe(true);
    expect(loaded.repairReportPath).toBeTruthy();
    expect(loaded.entries).toEqual([]);
    const report = await readFile(loaded.repairReportPath!, "utf8");
    expect(report).toContain("missing matching tool_call");
  });

  test("recovers the longest valid prefix in recover mode", async () => {
    const workspaceRoot = await createWorkspace();
    const store = new SessionStore({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      model: "mock",
    });
    const session = await store.createSession("sess_recoverable");
    const { appendFile } = await import("node:fs/promises");

    await appendFile(
      session.path,
      `${JSON.stringify({
        type: "message",
        role: "user",
        messageId: "msg_user",
        timestamp: "2026-04-13T00:00:00.000Z",
        content: "hello",
      })}\n`,
    );
    await appendFile(
      session.path,
      `${JSON.stringify({
        type: "tool_result",
        toolCallId: "missing",
        ok: true,
        content: "oops",
        timestamp: "2026-04-13T00:00:01.000Z",
      })}\n`,
    );

    const recovered = await store.loadSession(session.sessionId, { mode: "recover" });

    expect(recovered.status).toBe("degraded");
    expect(recovered.corrupted).toBe(false);
    expect(recovered.recoveredFromPath).toBe(session.path);
    expect(recovered.entries).toHaveLength(1);
    expect(recovered.entries[0]).toMatchObject({
      type: "message",
      role: "user",
      content: "hello",
    });
    expect(recovered.repairNotes.some((note) => note.includes("missing matching tool_call"))).toBe(true);
  });

  test("recover mode returns no entries when the session header is missing", async () => {
    const workspaceRoot = await createWorkspace();
    const sessionDir = path.join(workspaceRoot, ".mini-agent", "sessions");
    const sessionPath = path.join(sessionDir, "2026-04-13T00-00-00.000Z_sess_missing_header.jsonl");
    const { mkdir, writeFile } = await import("node:fs/promises");

    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        role: "user",
        messageId: "msg_1",
        timestamp: "2026-04-13T00:00:00.000Z",
        content: "orphaned entry",
      })}\n`,
      "utf8",
    );

    const store = new SessionStore({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      model: "mock",
    });

    const recovered = await store.loadSession("sess_missing_header", { mode: "recover" });

    expect(recovered.status).toBe("corrupted");
    expect(recovered.entries).toEqual([]);
    expect(recovered.repairNotes).toContain("missing or invalid session header");
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

  test("toFileSafeIso replaces colons, plus signs, and dots", () => {
    const result = toFileSafeIso(new Date("2024-05-01T03:04:05.678+08:00"));
    expect(result).not.toContain(":");
    expect(result).not.toContain("+");
    expect(result).not.toContain(".");
  });

  test("throws RuntimeError with SESSION_NOT_FOUND when sessionId is unknown", async () => {
    const workspaceRoot = await createWorkspace();
    const store = new SessionStore({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      model: "mock",
    });

    await expect(store.appendEntry("sess_does_not_exist", {
      type: "message",
      role: "user",
      messageId: "msg_1",
      timestamp: "2026-04-13T00:00:00.000Z",
      content: "hello",
    })).rejects.toMatchObject({
      name: "RuntimeError",
      code: "SESSION_NOT_FOUND",
    });

    try {
      await store.appendEntry("sess_does_not_exist", {
        type: "message",
        role: "user",
        messageId: "msg_2",
        timestamp: "2026-04-13T00:00:00.000Z",
        content: "hello",
      });
      throw new Error("expected error");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeError);
      expect((error as RuntimeError).code).toBe("SESSION_NOT_FOUND");
      expect((error as RuntimeError).message.startsWith("Session not found:")).toBe(true);
    }
  });
});
