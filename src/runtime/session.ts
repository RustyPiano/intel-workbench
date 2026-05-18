import { mkdir, readdir, writeFile } from "node:fs/promises";
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

export interface SessionLoadOptions {
  mode?: SessionLoadMode;
}

export class SessionStore {
  private readonly workspaceRoot: string;
  private readonly runtimeVersion: string;
  private readonly model: string;
  private readonly sessionDir: string;
  private readonly reportDir: string;
  private readonly sessionPaths = new Map<string, string>();

  constructor(options: SessionStoreOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.runtimeVersion = options.runtimeVersion;
    this.model = options.model;
    this.sessionDir = options.sessionDir
      ? path.resolve(this.workspaceRoot, options.sessionDir)
      : path.join(this.workspaceRoot, ".mini-agent", "sessions");
    this.reportDir = path.join(this.workspaceRoot, ".mini-agent", "artifacts", "reports");
  }

  async createSession(sessionId = createId("sess")): Promise<CreatedSession> {
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
    await writeJsonlLine(sessionPath, entry);
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
    const knownPath = this.sessionPaths.get(sessionId);
    if (knownPath) {
      return knownPath;
    }

    const sessions = await this.listSessions();
    const match = sessions.find((session) => session.sessionId === sessionId);

    if (!match) {
      throw new RuntimeError({
        code: "SESSION_CORRUPTED",
        message: `Session not found: ${sessionId}`,
      });
    }

    return match.path;
  }
}
