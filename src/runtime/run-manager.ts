import path from "node:path";

import type { GenerateResult } from "../model/types.js";
import { createId } from "../utils/ids.js";
import type { ToolExecutionResult, ToolArtifact } from "../tools/types.js";
import type { EventBus } from "./events.js";
import type { RuntimeErrorShape } from "./errors.js";
import { classifyRunFailure, createTraceSummary, formatDuration, previewValue, type RunEvent, type RunFailure, type RunStatus } from "./trace.js";
import { RunStore, type CreatedRun } from "./run-store.js";
import type { AssistantMessage, ToolCall } from "./types.js";

export interface RunManagerOptions {
  workspaceRoot: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  eventBus: EventBus;
  runStore: RunStore;
  prompt: string;
  maxTurns: number;
  resumedFromSession?: boolean;
}

function summarizeToolCall(toolCall: ToolCall): string {
  if (toolCall.name === "read" && typeof toolCall.arguments.path === "string") {
    return `read ${toolCall.arguments.path}`;
  }

  if (toolCall.name === "write" && typeof toolCall.arguments.path === "string") {
    return `write ${toolCall.arguments.path}`;
  }

  if (toolCall.name === "edit" && typeof toolCall.arguments.path === "string") {
    return `edit ${toolCall.arguments.path}`;
  }

  if (toolCall.name === "activate_skill" && typeof toolCall.arguments.name === "string") {
    return `activate_skill ${toolCall.arguments.name}`;
  }

  if (toolCall.name === "bash" && typeof toolCall.arguments.command === "string") {
    return createTraceSummary(`bash ${toolCall.arguments.command}`, 120);
  }

  return toolCall.name;
}

function createArtifactSummary(artifact: ToolArtifact): string {
  return createTraceSummary(`${artifact.type} ${artifact.path}`, 120);
}

export class RunManager {
  readonly runId: string;
  readonly traceId: string;
  readonly tracePath: string;
  readonly artifactsDir: string;

  private readonly created: CreatedRun;
  private readonly startedAt: string;
  private seq = 0;
  private toolCalls = 0;
  private skillActivations = 0;
  private artifactCount = 0;
  private status: RunStatus = "pending";
  private firstError: RunFailure | null = null;
  private finished = false;

  private constructor(
    private readonly options: RunManagerOptions,
    created: CreatedRun,
    startedAt: string,
  ) {
    this.created = created;
    this.startedAt = startedAt;
    this.runId = created.runId;
    this.traceId = created.traceId;
    this.tracePath = created.tracePath;
    this.artifactsDir = created.artifactsDir;
  }

  static async start(options: RunManagerOptions): Promise<RunManager> {
    const startedAt = new Date().toISOString();
    const created = await options.runStore.createRun({
      sessionId: options.sessionId,
      provider: options.provider,
      model: options.model,
      startedAt,
    });
    const manager = new RunManager(options, created, startedAt);

    await manager.options.runStore.updateMeta(manager.runId, { status: "started" });
    await manager.emit({
      type: "run_started",
      phase: "system",
      level: "info",
      summary: "Started run",
      data: {
        input_preview: previewValue(options.prompt),
        cwd: options.workspaceRoot,
        max_turns: options.maxTurns,
      },
    });

    if (options.resumedFromSession) {
      await manager.emit({
        type: "session_resumed",
        phase: "system",
        level: "debug",
        summary: "Resumed previous session state",
        data: {
          session_id: options.sessionId,
        },
      });
    }

    await manager.emitPlanningSummary("plan", "Plan the next step and decide whether tools are needed.");
    return manager;
  }

  async emitPlanningSummary(kind: "plan" | "decision" | "progress", text: string, source: "runtime" | "model" = "runtime"): Promise<void> {
    this.status = kind === "progress" ? "executing" : "planning";
    await this.options.runStore.updateMeta(this.runId, { status: this.status });
    await this.emit({
      type: "planning_summary",
      phase: "planning",
      level: "info",
      summary: createTraceSummary(text),
      data: {
        source,
        kind,
        text: createTraceSummary(text, 240),
      },
    });
  }

  async recordModelRequest(turn: number): Promise<void> {
    await this.emit({
      type: "model_request_started",
      phase: "model",
      level: "debug",
      summary: "Requesting model completion",
      data: {
        turn,
        provider: this.options.provider,
        model: this.options.model,
      },
    });
  }

  async recordModelResponse(turn: number, result: GenerateResult): Promise<void> {
    await this.emit({
      type: "model_response_received",
      phase: "model",
      level: "debug",
      summary: `Model responded with ${result.stopReason}`,
      data: {
        turn,
        stop_reason: result.stopReason,
        usage: result.usage,
      },
    });
  }

  async recordToolStarted(toolCall: ToolCall): Promise<void> {
    this.status = "executing";
    await this.options.runStore.updateMeta(this.runId, { status: this.status });
    await this.emit({
      type: "tool_started",
      phase: "tool",
      level: "info",
      summary: summarizeToolCall(toolCall),
      data: {
        tool_name: toolCall.name,
        call_id: toolCall.id,
        args_preview: previewValue(toolCall.arguments),
      },
    });
  }

  async recordToolProgress(toolCall: ToolCall, partial: string): Promise<void> {
    await this.emit({
      type: "tool_progress",
      phase: "tool",
      level: "debug",
      summary: createTraceSummary(`${toolCall.name} progress: ${partial}`),
      data: {
        tool_name: toolCall.name,
        call_id: toolCall.id,
        stream: "status",
        chunk_preview: createTraceSummary(partial, 240),
      },
    });
  }

  async recordToolCompleted(toolCall: ToolCall, result: ToolExecutionResult): Promise<void> {
    this.toolCalls += 1;
    const meta = typeof result.meta === "object" && result.meta !== null ? (result.meta as Record<string, unknown>) : undefined;

    if (result.error && !this.firstError) {
      this.firstError = classifyRunFailure(result.error);
    }

    await this.emit({
      type: "tool_completed",
      phase: "tool",
      level: result.ok ? "info" : "error",
      summary: result.ok
        ? createTraceSummary(`${toolCall.name} completed`)
        : createTraceSummary(`${toolCall.name} failed: ${result.content}`),
      data: {
        tool_name: toolCall.name,
        call_id: toolCall.id,
        ok: result.ok,
        result_preview: previewValue(result.content),
        artifact_paths: result.artifacts?.map((artifact) => artifact.path) ?? [],
        stdout_tail: typeof meta?.stdoutTail === "string" ? meta.stdoutTail : undefined,
        stderr_tail: typeof meta?.stderrTail === "string" ? meta.stderrTail : undefined,
        log_path: typeof meta?.logPath === "string" ? meta.logPath : undefined,
      },
    });

    for (const artifact of result.artifacts ?? []) {
      await this.recordArtifact(artifact);
    }
  }

  async recordSkillActivated(skillName: string, skillDir?: string, resourceCount?: number): Promise<void> {
    this.skillActivations += 1;
    await this.emit({
      type: "skill_activated",
      phase: "skill",
      level: "info",
      summary: createTraceSummary(`activated ${skillName}`),
      data: {
        skill_name: skillName,
        skill_dir: skillDir,
        resource_count: resourceCount ?? 0,
      },
    });
  }

  async recordArtifact(artifact: ToolArtifact): Promise<void> {
    this.artifactCount += 1;
    await this.emit({
      type: "artifact_created",
      phase: "artifact",
      level: "info",
      summary: createArtifactSummary(artifact),
      data: {
        artifact_type: artifact.type,
        path: artifact.path,
        description: artifact.description ?? "",
      },
    });
  }

  async recordAssistantCompleted(message: AssistantMessage): Promise<void> {
    this.status = "finalizing";
    await this.options.runStore.updateMeta(this.runId, { status: this.status });
    await this.emit({
      type: "assistant_completed",
      phase: "finalize",
      level: "info",
      summary: createTraceSummary(message.content || "Assistant response ready"),
      data: {
        output_preview: previewValue(message.content),
        char_count: message.content.length,
      },
    });
  }

  async complete(): Promise<void> {
    if (this.finished) {
      return;
    }

    this.finished = true;
    this.status = "completed";
    const durationMs = Date.parse(new Date().toISOString()) - Date.parse(this.startedAt);

    await this.emit({
      type: "run_completed",
      phase: "finalize",
      level: "info",
      summary: `Run completed in ${formatDuration(durationMs)}`,
      data: {
        duration_ms: durationMs,
        tool_calls: this.toolCalls,
        skill_activations: this.skillActivations,
        artifact_count: this.artifactCount,
      },
    });

    const meta = await this.options.runStore.finalizeRun(this.runId, {
      status: "completed",
      durationMs,
      toolCalls: this.toolCalls,
      skillActivations: this.skillActivations,
      artifactCount: this.artifactCount,
      firstErrorCode: this.firstError?.error_code,
    });
    await this.writeDiagnostics(meta);
  }

  async cancel(error: RuntimeErrorShape): Promise<void> {
    if (this.finished) {
      return;
    }

    this.finished = true;
    this.status = "cancelled";
    const durationMs = Date.parse(new Date().toISOString()) - Date.parse(this.startedAt);
    const failure = classifyRunFailure(error);
    this.firstError ??= failure;

    await this.emit({
      type: "run_cancelled",
      phase: "error",
      level: "warn",
      summary: createTraceSummary(`Run cancelled: ${failure.user_message}`),
      data: {
        error_code: failure.error_code,
        error_layer: failure.error_layer,
        user_message: failure.user_message,
        debug_message: failure.debug_message,
        duration_ms: durationMs,
      },
    });

    const meta = await this.options.runStore.finalizeRun(this.runId, {
      status: "cancelled",
      durationMs,
      toolCalls: this.toolCalls,
      skillActivations: this.skillActivations,
      artifactCount: this.artifactCount,
      firstErrorCode: failure.error_code,
    });
    await this.writeDiagnostics(meta, failure);
  }

  async fail(error: RuntimeErrorShape): Promise<void> {
    if (this.finished) {
      return;
    }

    this.finished = true;
    this.status = "failed";
    const durationMs = Date.parse(new Date().toISOString()) - Date.parse(this.startedAt);
    const failure = classifyRunFailure(error);
    this.firstError ??= failure;

    await this.emit({
      type: "run_failed",
      phase: "error",
      level: "error",
      summary: createTraceSummary(`Run failed in ${failure.error_layer}: ${error.message}`),
      data: {
        error_code: failure.error_code,
        error_layer: failure.error_layer,
        user_message: failure.user_message,
        debug_message: failure.debug_message,
      },
    });

    const meta = await this.options.runStore.finalizeRun(this.runId, {
      status: "failed",
      durationMs,
      toolCalls: this.toolCalls,
      skillActivations: this.skillActivations,
      artifactCount: this.artifactCount,
      firstErrorCode: failure.error_code,
    });
    await this.writeDiagnostics(meta, failure);
  }

  private async writeDiagnostics(meta: Awaited<ReturnType<RunStore["finalizeRun"]>>, failure?: RunFailure): Promise<void> {
    const trace = await this.options.runStore.loadTrace(this.runId, { mode: "recover" }).catch(() => undefined);
    await this.options.runStore.writeLastRun({
      ...meta,
      trace_status: trace?.status ?? "unknown",
      trace_path: this.tracePath,
      artifacts_dir: this.artifactsDir,
      error_layer: failure?.error_layer,
      user_message: failure?.user_message,
    });
  }

  private async emit(input: Omit<RunEvent, "schema_version" | "event_id" | "trace_id" | "run_id" | "session_id" | "seq" | "ts">): Promise<RunEvent> {
    this.seq += 1;
    const event: RunEvent = {
      schema_version: "v1.2",
      event_id: createId("evt"),
      trace_id: this.traceId,
      run_id: this.runId,
      session_id: this.options.sessionId,
      seq: this.seq,
      ts: new Date().toISOString(),
      ...input,
    };
    await this.options.runStore.appendEvent(event);
    this.options.eventBus.emit(event);
    return event;
  }
}
