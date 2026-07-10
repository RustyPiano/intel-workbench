import { mkdir, open, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SessionEntry, SessionHeader } from "./types.js";
import { RuntimeError } from "./errors.js";
import { createId } from "../utils/ids.js";
import { readJsonlFile, writeJsonlLine } from "../utils/jsonl.js";

export function toFileSafeIso(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll("+", "-").replaceAll(".", "-");
}

export interface SessionStoreOptions {
  workspaceRoot: string;
  runtimeVersion: string;
  model: string;
  sessionDir?: string;
  sessionLockStaleMs?: number;
  sessionLockPollMs?: number;
}

export interface CreatedSession {
  sessionId: string;
  path: string;
}

export interface LoadedSession {
  header: SessionHeader | null;
  entries: SessionEntry[];
  status: SessionHealth;
  corrupted: boolean;
  repairNotes: string[];
  repairReportPath?: string;
  recoveredFromPath?: string;
  path: string;
}

export type SessionHealth = "valid" | "degraded" | "corrupted";
export type SessionLoadMode = "strict" | "recover";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DEFAULT_SESSION_LOCK_STALE_MS = 60 * 60 * 1000;
const DEFAULT_SESSION_LOCK_POLL_MS = 50;

interface SessionLockRecord {
  token: string;
  pid: number;
  createdAt: string;
}

function assertValidSessionId(sessionId: string): void {
  if (SESSION_ID_PATTERN.test(sessionId)) return;
  throw new RuntimeError({
    code: "INVALID_ARGS",
    message: "Session id must be 1-128 characters using only letters, numbers, '.', '_' or '-'",
  });
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function waitForLock(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new RuntimeError({ code: "RUN_ABORTED", message: "Run aborted while waiting for session lock", retriable: true }));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => done(new RuntimeError({
      code: "RUN_ABORTED",
      message: "Run aborted while waiting for session lock",
      retriable: true,
    }));
    function done(error?: Error): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export interface SessionLoadOptions {
  mode?: SessionLoadMode;
}

export class SessionStore {
  private readonly workspaceRoot: string;
  private readonly runtimeVersion: string;
  private readonly model: string;
  private readonly sessionDir: string;
  private readonly reportDir: string;
  private readonly sessionLockStaleMs: number;
  private readonly sessionLockPollMs: number;
  private readonly sessionPaths = new Map<string, string>();

  constructor(options: SessionStoreOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.runtimeVersion = options.runtimeVersion;
    this.model = options.model;
    this.sessionDir = options.sessionDir
      ? path.resolve(this.workspaceRoot, options.sessionDir)
      : path.join(this.workspaceRoot, ".mini-agent", "sessions");
    this.reportDir = path.join(this.workspaceRoot, ".mini-agent", "artifacts", "reports");
    this.sessionLockStaleMs = options.sessionLockStaleMs ?? DEFAULT_SESSION_LOCK_STALE_MS;
    this.sessionLockPollMs = options.sessionLockPollMs ?? DEFAULT_SESSION_LOCK_POLL_MS;
  }

  async withSessionLock<T>(sessionId: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    assertValidSessionId(sessionId);
    await mkdir(this.sessionDir, { recursive: true });
    const lockPath = path.join(this.sessionDir, `.${sessionId}.lock`);
    const token = createId("lock");
    await this.acquireSessionLock(lockPath, token, signal);
    try {
      const result = await operation();
      await this.releaseSessionLock(lockPath, token);
      return result;
    } catch (error) {
      await this.releaseSessionLock(lockPath, token).catch(() => {});
      throw error;
    }
  }

  async createSession(sessionId = createId("sess")): Promise<CreatedSession> {
    assertValidSessionId(sessionId);
    await mkdir(this.sessionDir, { recursive: true });

    const pathSafeTimestamp = toFileSafeIso(new Date());
    const sessionPath = path.join(this.sessionDir, `${pathSafeTimestamp}_${sessionId}.jsonl`);
    const header: SessionHeader = {
      type: "session_header",
      version: 1,
      sessionId,
      createdAt: new Date().toISOString(),
      workspaceRoot: this.workspaceRoot,
      model: this.model,
      runtimeVersion: this.runtimeVersion,
    };

    await writeJsonlLine(sessionPath, header, true);
    this.sessionPaths.set(sessionId, sessionPath);

    return {
      sessionId,
      path: sessionPath,
    };
  }

  async appendEntry(sessionId: string, entry: Exclude<SessionEntry, SessionHeader>): Promise<void> {
    const sessionPath = await this.resolveSessionPath(sessionId);
    await writeJsonlLine(sessionPath, entry, false, { skipParentCheck: true });
  }

  async loadSession(sessionIdOrPath: string, options: SessionLoadOptions = {}): Promise<LoadedSession> {
    const mode = options.mode ?? "strict";
    const sessionPath = sessionIdOrPath.endsWith(".jsonl")
      ? path.resolve(sessionIdOrPath)
      : await this.resolveSessionPath(sessionIdOrPath);
    const lines = await readJsonlFile(sessionPath);

    let header: SessionHeader | null = null;
    const entries: SessionEntry[] = [];
    const recoverableEntries: SessionEntry[] = [];
    const repairNotes: string[] = [];
    const seenToolCalls = new Map<string, string>();
    const openToolCalls = new Set<string>();
    let pendingAssistantToolCalls = new Set<string>();
    let lastActivatableToolCallId: string | null = null;
    let recoverable = true;

    for (const [index, line] of lines.entries()) {
      try {
        const parsed = JSON.parse(line) as SessionEntry;
        const entryNotes: string[] = [];

        if (index === 0) {
          if (parsed.type !== "session_header") {
            repairNotes.push("missing or invalid session header");
            recoverable = false;
            continue;
          }

          header = parsed;
          continue;
        }

        if (parsed.type === "message") {
          if (openToolCalls.size > 0 || pendingAssistantToolCalls.size > 0) {
            entryNotes.push(`${parsed.role} message appears before pending tool calls completed`);
          }

          pendingAssistantToolCalls =
            parsed.role === "assistant" && parsed.toolCalls?.length
              ? new Set(parsed.toolCalls.map((toolCall) => toolCall.id))
              : new Set<string>();
          lastActivatableToolCallId = null;
        }

        if (parsed.type === "tool_call") {
          const declaredByAssistant = pendingAssistantToolCalls.has(parsed.toolCallId);
          if (!declaredByAssistant) {
            entryNotes.push(`tool_call ${parsed.toolCallId} is out of order`);
          } else {
            pendingAssistantToolCalls.delete(parsed.toolCallId);
          }

          seenToolCalls.set(parsed.toolCallId, parsed.toolName);
          openToolCalls.add(parsed.toolCallId);
          lastActivatableToolCallId = null;
        }

        if (parsed.type === "tool_result") {
          if (!seenToolCalls.has(parsed.toolCallId)) {
            entryNotes.push(`tool_result ${parsed.toolCallId} is missing matching tool_call`);
          } else if (!openToolCalls.has(parsed.toolCallId)) {
            entryNotes.push(`tool_result ${parsed.toolCallId} is out of order`);
          } else {
            openToolCalls.delete(parsed.toolCallId);
          }

          lastActivatableToolCallId = parsed.ok ? parsed.toolCallId : null;
        }

        if (parsed.type === "skill_activation") {
          const activatingToolName = lastActivatableToolCallId ? seenToolCalls.get(lastActivatableToolCallId) : undefined;
          if (activatingToolName !== "activate_skill") {
            entryNotes.push(`skill_activation ${parsed.skill} is out of order`);
          }

          lastActivatableToolCallId = null;
        }

        if (entryNotes.length > 0) {
          repairNotes.push(...entryNotes);
          recoverable = false;
        }

        entries.push(parsed);
        if (recoverable) {
          recoverableEntries.push(parsed);
        } else if (mode === "recover") {
          break;
        }
      } catch (error) {
        repairNotes.push(`invalid json at line ${index + 1}: ${error instanceof Error ? error.message : "unknown parse error"}`);
        recoverable = false;
        if (mode === "recover") {
          break;
        }
      }
    }

    if (!header) {
      repairNotes.push("session header could not be recovered");
    }

    if (repairNotes.length === 0) {
      return {
        header,
        entries,
        status: "valid",
        corrupted: false,
        repairNotes,
        path: sessionPath,
      };
    }

    await mkdir(this.reportDir, { recursive: true });
    const sessionStem = path.basename(sessionPath, ".jsonl");
    const reportPath = path.join(this.reportDir, `${sessionStem}-repair-report.txt`);
    await writeFile(reportPath, repairNotes.join("\n"), "utf8");

    const status: SessionHealth = mode === "recover" && header ? "degraded" : "corrupted";

    const recoveredEntries = mode === "recover" ? recoverableEntries : [];

    return {
      header,
      entries: recoveredEntries,
      status,
      corrupted: status === "corrupted",
      repairNotes,
      repairReportPath: reportPath,
      recoveredFromPath: status === "degraded" ? sessionPath : undefined,
      path: sessionPath,
    };
  }

  async listSessions(): Promise<CreatedSession[]> {
    await mkdir(this.sessionDir, { recursive: true });
    const entries = await readdir(this.sessionDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => {
        const sessionId = entry.name.replace(/^[^_]+_/u, "").replace(/\.jsonl$/u, "");
        const sessionPath = path.join(this.sessionDir, entry.name);
        this.sessionPaths.set(sessionId, sessionPath);
        return {
          sessionId,
          path: sessionPath,
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  private async resolveSessionPath(sessionId: string): Promise<string> {
    assertValidSessionId(sessionId);
    const knownPath = this.sessionPaths.get(sessionId);
    if (knownPath) {
      return knownPath;
    }

    const sessions = await this.listSessions();
    const match = sessions.find((session) => session.sessionId === sessionId);

    if (!match) {
      throw new RuntimeError({
        code: "SESSION_NOT_FOUND",
        message: `Session not found: ${sessionId}`,
      });
    }

    return match.path;
  }

  private async acquireSessionLock(lockPath: string, token: string, signal?: AbortSignal): Promise<void> {
    const record: SessionLockRecord = { token, pid: process.pid, createdAt: new Date().toISOString() };
    while (true) {
      try {
        const handle = await open(lockPath, "wx");
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        } catch (error) {
          await handle.close().catch(() => {});
          await unlink(lockPath).catch(() => {});
          throw error;
        }
        await handle.close();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      if (await this.removeStaleSessionLock(lockPath)) continue;
      await waitForLock(this.sessionLockPollMs, signal);
    }
  }

  private async removeStaleSessionLock(lockPath: string): Promise<boolean> {
    let raw: string;
    let modifiedAtMs: number;
    try {
      [raw, modifiedAtMs] = await Promise.all([
        readFile(lockPath, "utf8"),
        stat(lockPath).then((entry) => entry.mtimeMs),
      ]);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }

    let record: Partial<SessionLockRecord> = {};
    try {
      record = JSON.parse(raw) as Partial<SessionLockRecord>;
    } catch {
      // An incomplete lock is only stale after its file timestamp expires.
    }
    const hasValidPid = typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0;
    if (hasValidPid && processIsAlive(record.pid!)) return false;
    if (!hasValidPid && Date.now() - modifiedAtMs < this.sessionLockStaleMs) return false;

    try {
      if (await readFile(lockPath, "utf8") !== raw) return false;
      await unlink(lockPath);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  private async releaseSessionLock(lockPath: string, token: string): Promise<void> {
    try {
      const record = JSON.parse(await readFile(lockPath, "utf8")) as Partial<SessionLockRecord>;
      if (record.token === token) await unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
