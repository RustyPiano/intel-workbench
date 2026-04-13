import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createId } from "../utils/ids.js";
import { readJsonlFile, writeJsonlLine } from "../utils/jsonl.js";
import type { LoadedRunTrace, RunEvent, RunHealth, RunLoadMode, RunMeta, RunStatus } from "./trace.js";

export interface RunStoreOptions {
  workspaceRoot: string;
  runsDir?: string;
  diagnosticsDir?: string;
}

export interface CreateRunOptions {
  sessionId?: string;
  provider?: string;
  model?: string;
  startedAt?: string;
  runId?: string;
  traceId?: string;
}

export interface CreatedRun {
  runId: string;
  traceId: string;
  runDir: string;
  tracePath: string;
  metaPath: string;
  artifactsDir: string;
}

export interface RunLoadOptions {
  mode?: RunLoadMode;
}

export interface RunFinalizeOptions {
  status: RunStatus;
  endedAt?: string;
  durationMs?: number;
  toolCalls?: number;
  skillActivations?: number;
  artifactCount?: number;
  firstErrorCode?: string;
}

export interface RunMetaPatch {
  status?: RunStatus;
  ended_at?: string;
  duration_ms?: number;
  tool_calls?: number;
  skill_activations?: number;
  artifact_count?: number;
  first_error_code?: string;
}

function isTerminalEvent(type: string): boolean {
  return type === "run_completed" || type === "run_failed" || type === "run_cancelled";
}

export class RunStore {
  private readonly workspaceRoot: string;
  private readonly runsDir: string;
  private readonly diagnosticsDir: string;
  private readonly runPaths = new Map<string, CreatedRun>();

  constructor(options: RunStoreOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.runsDir = options.runsDir
      ? path.resolve(this.workspaceRoot, options.runsDir)
      : path.join(this.workspaceRoot, ".mini-agent", "runs");
    this.diagnosticsDir = options.diagnosticsDir
      ? path.resolve(this.workspaceRoot, options.diagnosticsDir)
      : path.join(this.workspaceRoot, ".mini-agent", "diagnostics");
  }

  async createRun(options: CreateRunOptions = {}): Promise<CreatedRun> {
    const runId = options.runId ?? createId("run");
    const traceId = options.traceId ?? createId("trace");
    const runDir = path.join(this.runsDir, runId);
    const tracePath = path.join(runDir, "trace.jsonl");
    const metaPath = path.join(runDir, "meta.json");
    const artifactsDir = path.join(runDir, "artifacts");
    const startedAt = options.startedAt ?? new Date().toISOString();

    await mkdir(artifactsDir, { recursive: true });
    const meta: RunMeta = {
      run_id: runId,
      trace_id: traceId,
      session_id: options.sessionId,
      status: "pending",
      started_at: startedAt,
      provider: options.provider,
      model: options.model,
      tool_calls: 0,
      skill_activations: 0,
      artifact_count: 0,
    };
    await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

    const created = {
      runId,
      traceId,
      runDir,
      tracePath,
      metaPath,
      artifactsDir,
    } satisfies CreatedRun;
    this.runPaths.set(runId, created);
    return created;
  }

  async appendEvent(event: RunEvent): Promise<void> {
    const created = await this.resolveRunPaths(event.run_id);
    await writeJsonlLine(created.tracePath, event);
  }

  async loadMeta(runId: string): Promise<RunMeta> {
    const created = await this.resolveRunPaths(runId);
    return JSON.parse(await readFile(created.metaPath, "utf8")) as RunMeta;
  }

  async updateMeta(runId: string, patch: RunMetaPatch): Promise<RunMeta> {
    const meta = await this.loadMeta(runId);
    const nextMeta = {
      ...meta,
      ...patch,
    } satisfies RunMeta;
    const created = await this.resolveRunPaths(runId);
    await writeFile(created.metaPath, `${JSON.stringify(nextMeta, null, 2)}\n`, "utf8");
    return nextMeta;
  }

  async finalizeRun(runId: string, options: RunFinalizeOptions): Promise<RunMeta> {
    return this.updateMeta(runId, {
      status: options.status,
      ended_at: options.endedAt ?? new Date().toISOString(),
      duration_ms: options.durationMs,
      tool_calls: options.toolCalls,
      skill_activations: options.skillActivations,
      artifact_count: options.artifactCount,
      first_error_code: options.firstErrorCode,
    });
  }

  async listRuns(): Promise<RunMeta[]> {
    try {
      await access(this.runsDir);
    } catch {
      return [];
    }

    const entries = await readdir(this.runsDir, { withFileTypes: true });
    const metas = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const metaPath = path.join(this.runsDir, entry.name, "meta.json");
          try {
            return JSON.parse(await readFile(metaPath, "utf8")) as RunMeta;
          } catch {
            return null;
          }
        }),
    );

    return metas
      .filter((meta): meta is RunMeta => meta !== null)
      .sort((left, right) => right.started_at.localeCompare(left.started_at));
  }

  async loadTrace(runId: string, options: RunLoadOptions = {}): Promise<LoadedRunTrace> {
    const mode = options.mode ?? "strict";
    const created = await this.resolveRunPaths(runId);
    const meta = await this.loadMeta(runId);
    const repairNotes: string[] = [];
    const events: RunEvent[] = [];
    const recoveredEvents: RunEvent[] = [];
    let lastSeq = 0;
    let seenTerminal = false;
    let recoverable = true;
    const openToolCalls = new Set<string>();

    let lines: string[] = [];
    try {
      lines = await readJsonlFile(created.tracePath);
    } catch (error) {
      repairNotes.push(`trace could not be read: ${error instanceof Error ? error.message : "unknown error"}`);
      return {
        meta,
        events: [],
        status: "corrupted",
        repairNotes,
        tracePath: created.tracePath,
        metaPath: created.metaPath,
      };
    }

    for (const [index, line] of lines.entries()) {
      try {
        const parsed = JSON.parse(line) as RunEvent;
        const entryNotes: string[] = [];

        if (parsed.schema_version !== "v1.2") {
          entryNotes.push(`invalid schema_version at line ${index + 1}`);
        }
        if (index === 0 && parsed.type !== "run_started") {
          entryNotes.push("trace must start with run_started");
        }
        if (parsed.seq <= lastSeq) {
          entryNotes.push(`non-increasing seq at line ${index + 1}`);
        }

        if (parsed.type === "tool_started") {
          const callId = typeof parsed.data?.call_id === "string" ? parsed.data.call_id : undefined;
          if (!callId) {
            entryNotes.push(`tool_started missing call_id at line ${index + 1}`);
          } else {
            openToolCalls.add(callId);
          }
        }

        if (parsed.type === "tool_completed") {
          const callId = typeof parsed.data?.call_id === "string" ? parsed.data.call_id : undefined;
          if (!callId || !openToolCalls.has(callId)) {
            entryNotes.push(`tool_completed is missing matching tool_started at line ${index + 1}`);
          } else {
            openToolCalls.delete(callId);
          }
        }

        if (isTerminalEvent(parsed.type)) {
          if (seenTerminal) {
            entryNotes.push(`terminal event must appear exactly once at the end (line ${index + 1})`);
          }
          seenTerminal = true;
        } else if (seenTerminal) {
          entryNotes.push(`unexpected event after terminal event at line ${index + 1}`);
        }

        if (entryNotes.length > 0) {
          repairNotes.push(...entryNotes);
          recoverable = false;
        }

        events.push(parsed);
        if (recoverable) {
          recoveredEvents.push(parsed);
        } else if (mode === "recover") {
          break;
        }
        lastSeq = parsed.seq;
      } catch (error) {
        repairNotes.push(`invalid json at line ${index + 1}: ${error instanceof Error ? error.message : "unknown parse error"}`);
        recoverable = false;
        if (mode === "recover") {
          break;
        }
      }
    }

    const status = this.resolveHealthStatus(repairNotes, mode, seenTerminal);
    return {
      meta,
      events: status === "degraded" ? recoveredEvents : events,
      status,
      repairNotes,
      tracePath: created.tracePath,
      metaPath: created.metaPath,
    };
  }

  async writeLastRun(snapshot: Record<string, unknown>): Promise<string> {
    await mkdir(this.diagnosticsDir, { recursive: true });
    const diagnosticsPath = path.join(this.diagnosticsDir, "last-run.json");
    await writeFile(diagnosticsPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    return diagnosticsPath;
  }

  async readLastRun(): Promise<Record<string, unknown> | null> {
    const diagnosticsPath = path.join(this.diagnosticsDir, "last-run.json");
    try {
      return JSON.parse(await readFile(diagnosticsPath, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async getArtifactsDir(runId: string): Promise<string> {
    const created = await this.resolveRunPaths(runId);
    return created.artifactsDir;
  }

  private resolveHealthStatus(repairNotes: string[], mode: RunLoadMode, seenTerminal: boolean): RunHealth {
    if (repairNotes.length === 0 && seenTerminal) {
      return "valid";
    }

    if (mode === "recover") {
      return "degraded";
    }

    return "corrupted";
  }

  private async resolveRunPaths(runId: string): Promise<CreatedRun> {
    const known = this.runPaths.get(runId);
    if (known) {
      return known;
    }

    const runDir = path.join(this.runsDir, runId);
    const created = {
      runId,
      traceId: "",
      runDir,
      tracePath: path.join(runDir, "trace.jsonl"),
      metaPath: path.join(runDir, "meta.json"),
      artifactsDir: path.join(runDir, "artifacts"),
    } satisfies CreatedRun;
    this.runPaths.set(runId, created);
    return created;
  }
}
