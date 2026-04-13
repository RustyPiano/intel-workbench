import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SessionEntry, SessionHeader } from "./types.js";
import { createId } from "../utils/ids.js";
import { readJsonlFile, writeJsonlLine } from "../utils/jsonl.js";

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
  corrupted: boolean;
  repairReportPath?: string;
  path: string;
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

    const pathSafeTimestamp = new Date().toISOString().replaceAll(":", "-");
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

  async loadSession(sessionIdOrPath: string): Promise<LoadedSession> {
    const sessionPath = sessionIdOrPath.endsWith(".jsonl")
      ? path.resolve(sessionIdOrPath)
      : await this.resolveSessionPath(sessionIdOrPath);
    const lines = await readJsonlFile(sessionPath);

    let header: SessionHeader | null = null;
    const entries: SessionEntry[] = [];
    const repairNotes: string[] = [];
    const seenToolCalls = new Map<string, string>();
    const openToolCalls = new Set<string>();
    let pendingAssistantToolCalls = new Set<string>();
    let lastActivatableToolCallId: string | null = null;

    for (const [index, line] of lines.entries()) {
      try {
        const parsed = JSON.parse(line) as SessionEntry;

        if (index === 0) {
          if (parsed.type !== "session_header") {
            repairNotes.push("missing or invalid session header");
            continue;
          }

          header = parsed;
          continue;
        }

        if (parsed.type === "message") {
          if (openToolCalls.size > 0 || pendingAssistantToolCalls.size > 0) {
            repairNotes.push(`${parsed.role} message appears before pending tool calls completed`);
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
            repairNotes.push(`tool_call ${parsed.toolCallId} is out of order`);
          } else {
            pendingAssistantToolCalls.delete(parsed.toolCallId);
          }

          seenToolCalls.set(parsed.toolCallId, parsed.toolName);
          openToolCalls.add(parsed.toolCallId);
          lastActivatableToolCallId = null;
        }

        if (parsed.type === "tool_result") {
          if (!seenToolCalls.has(parsed.toolCallId)) {
            repairNotes.push(`tool_result ${parsed.toolCallId} is missing matching tool_call`);
          } else if (!openToolCalls.has(parsed.toolCallId)) {
            repairNotes.push(`tool_result ${parsed.toolCallId} is out of order`);
          } else {
            openToolCalls.delete(parsed.toolCallId);
          }

          lastActivatableToolCallId = parsed.ok ? parsed.toolCallId : null;
        }

        if (parsed.type === "skill_activation") {
          const activatingToolName = lastActivatableToolCallId ? seenToolCalls.get(lastActivatableToolCallId) : undefined;
          if (activatingToolName !== "activate_skill") {
            repairNotes.push(`skill_activation ${parsed.skill} is out of order`);
          }

          lastActivatableToolCallId = null;
        }

        entries.push(parsed);
      } catch (error) {
        repairNotes.push(`invalid json at line ${index + 1}: ${error instanceof Error ? error.message : "unknown parse error"}`);
      }
    }

    if (!header) {
      repairNotes.push("session header could not be recovered");
    }

    if (repairNotes.length === 0) {
      return {
        header,
        entries,
        corrupted: false,
        path: sessionPath,
      };
    }

    await mkdir(this.reportDir, { recursive: true });
    const sessionStem = path.basename(sessionPath, ".jsonl");
    const reportPath = path.join(this.reportDir, `${sessionStem}-repair-report.txt`);
    await writeFile(reportPath, repairNotes.join("\n"), "utf8");

    return {
      header,
      entries,
      corrupted: true,
      repairReportPath: reportPath,
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
      throw new Error(`Unknown session: ${sessionId}`);
    }

    return match.path;
  }
}
