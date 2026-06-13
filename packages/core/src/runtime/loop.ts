import type { ModelAdapter } from "../model/types.js";
import type { SessionStore } from "./session.js";
import type { AssistantMessage, RuntimeMessage, ToolCall, ToolResultEntry } from "./types.js";
import { createId } from "../utils/ids.js";
import type { ToolRegistry } from "../tools/index.js";
import { getToolJsonSchema, type ToolContext, type ToolExecutionResult } from "../tools/types.js";
import { isRuntimeError, RuntimeError, toRuntimeErrorShape } from "./errors.js";
import type { RunManager } from "./run-manager.js";

export type ToolMiddleware = (
  toolCall: ToolCall,
  next: () => Promise<ToolExecutionResult>,
) => Promise<ToolExecutionResult>;

export interface LoopDependencies {
  modelAdapter: ModelAdapter;
  toolRegistry: ToolRegistry;
  toolMiddleware?: ToolMiddleware;
  sessionStore: SessionStore;
  runManager: RunManager;
  signal?: AbortSignal;
  /** Build the cacheable base system prompt (workspace context + skill catalog). */
  createBaseSystemPrompt: () => Promise<string>;
  /** Build the active skills block (changes when activate_skill runs). */
  createActiveSkillsBlock: () => string;
  /** Snapshot of currently-active skill names. Used to invalidate the active block cache. */
  getActiveSkillNames: () => string[];
  createToolContext: (toolCall: ToolCall) => ToolContext;
  maxTurns: number;
}

export interface LoopResult {
  finalMessage: AssistantMessage;
  messages: RuntimeMessage[];
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (isRuntimeError(error) && error.code === "RUN_ABORTED") {
    return true;
  }

  return (error instanceof Error && error.name === "AbortError") || (signal?.aborted === true && error === signal.reason);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }

  throw new RuntimeError({
    code: "RUN_ABORTED",
    message: "Run aborted by signal",
    retriable: true,
  });
}

/**
 * Serialize a ToolExecutionResult into a stable string for inclusion in the
 * `tool` message content. The same function is used both in the live loop and
 * when replaying session entries, so live and resumed runs produce byte-for-byte
 * identical tool message content.
 *
 * Stable key order: `ok`, `content`, `meta`, `error`, `artifacts`. Optional
 * fields whose values are `undefined` are omitted, matching `JSON.stringify`
 * semantics, so legacy sessions (recorded before `artifacts` existed on the
 * runtime contract) continue to serialize identically.
 */
export function formatToolMessageContent(result: ToolExecutionResult): string {
  const ordered: Record<string, unknown> = {
    ok: result.ok,
    content: result.content,
  };
  if (result.meta !== undefined) {
    ordered.meta = result.meta;
  }
  if (result.error !== undefined) {
    ordered.error = result.error;
  }
  if (result.artifacts !== undefined) {
    ordered.artifacts = result.artifacts;
  }
  return JSON.stringify(ordered);
}

function computeSkillSignature(names: string[]): string {
  return [...names].sort().join(",");
}

function createMaxTurnsHandoffMessage(maxTurns: number): string {
  return `已达到本次运行的最大轮数（${maxTurns}）。我先停在这里，等待你确认是否继续；如果要继续，请直接回复“继续”，或下次用 --max-turns 提高限制。`;
}

export async function runAgentLoop(
  prompt: string,
  sessionId: string,
  dependencies: LoopDependencies,
  initialMessages: RuntimeMessage[] = [],
): Promise<LoopResult> {
  const messages: RuntimeMessage[] = [...initialMessages];
  const userMessageId = createId("msg");
  messages.push({
    role: "user",
    content: prompt,
    messageId: userMessageId,
  });
  await dependencies.sessionStore.appendEntry(sessionId, {
    type: "message",
    role: "user",
    messageId: userMessageId,
    timestamp: new Date().toISOString(),
    content: prompt,
    runId: dependencies.runManager.runId,
  });

  let turn = 0;
  let finalMessage: AssistantMessage | null = null;

  // Cache the base prompt (AGENTS.md + workspace context + skill catalog) for
  // the whole run. The active skills block is recomputed only when the active
  // skill set changes (e.g. after activate_skill).
  let cachedBase: string | null = null;
  let cachedSkillSignature: string | null = null;
  let cachedActiveBlock: string = "";

  const buildSystemPrompt = async (): Promise<string> => {
    if (cachedBase === null) {
      cachedBase = await dependencies.createBaseSystemPrompt();
    }
    const signature = computeSkillSignature(dependencies.getActiveSkillNames());
    if (signature !== cachedSkillSignature) {
      cachedActiveBlock = dependencies.createActiveSkillsBlock();
      cachedSkillSignature = signature;
    }
    return cachedActiveBlock ? `${cachedBase}\n${cachedActiveBlock}` : cachedBase;
  };

  try {
    while (turn < dependencies.maxTurns) {
      throwIfAborted(dependencies.signal);
      turn += 1;
      if (turn > 1) {
        await dependencies.runManager.emitPlanningSummary("progress", "Review tool results and plan the next step.");
      }

      const systemPrompt = await buildSystemPrompt();
      await dependencies.runManager.recordModelRequest(turn);
      const assistant = await dependencies.modelAdapter.generate({
        systemPrompt,
        messages,
        signal: dependencies.signal,
        tools: dependencies.toolRegistry.list().map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: getToolJsonSchema(tool),
        })),
      });
      throwIfAborted(dependencies.signal);
      await dependencies.runManager.recordModelResponse(turn, assistant);

      const assistantMessageId = createId("msg");
      const assistantMessage: AssistantMessage = {
        role: "assistant",
        content: assistant.message.content,
        messageId: assistantMessageId,
        toolCalls: assistant.message.toolCalls ?? [],
      };
      messages.push(assistantMessage);
      await dependencies.sessionStore.appendEntry(sessionId, {
        type: "message",
        role: "assistant",
        messageId: assistantMessageId,
        timestamp: new Date().toISOString(),
        content: assistantMessage.content,
        runId: dependencies.runManager.runId,
        toolCalls: assistantMessage.toolCalls,
      });

      if (assistantMessage.toolCalls?.length) {
        await dependencies.runManager.emitPlanningSummary(
          turn === 1 ? "decision" : "progress",
          assistantMessage.content || `Preparing to call ${assistantMessage.toolCalls.map((toolCall) => toolCall.name).join(", ")}.`,
        );
      }

      if (!assistantMessage.toolCalls?.length) {
        finalMessage = assistantMessage;
        break;
      }

      for (const toolCall of assistantMessage.toolCalls) {
        throwIfAborted(dependencies.signal);
        await dependencies.runManager.recordToolStarted(toolCall);
        await dependencies.sessionStore.appendEntry(sessionId, {
          type: "tool_call",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: toolCall.arguments,
          timestamp: new Date().toISOString(),
          runId: dependencies.runManager.runId,
        });

        const runTool = () => dependencies.toolRegistry.execute(toolCall, dependencies.createToolContext(toolCall));
        let result: ToolExecutionResult;
        let invocationError: unknown = null;
        try {
          result = dependencies.toolMiddleware ? await dependencies.toolMiddleware(toolCall, runTool) : await runTool();
        } catch (error) {
          // toolMiddleware threw (e.g. an audit write-ahead append failed). The tool_call
          // entry was already journaled above; leaving it unanswered corrupts the session
          // on resume (session.ts flags a message after an open tool_call). Synthesize a
          // failed result so the existing journaling closes the tool_call, then rethrow
          // below to fail the run.
          invocationError = error;
          result = {
            ok: false,
            content: error instanceof Error ? error.message : "Tool middleware failed",
            error: toRuntimeErrorShape(error, isRuntimeError(error) ? error.code : "INTERNAL_ERROR"),
          };
        }
        const toolResultEntry: ToolResultEntry = {
          type: "tool_result",
          toolCallId: toolCall.id,
          ok: result.ok,
          content: result.content,
          timestamp: new Date().toISOString(),
          runId: dependencies.runManager.runId,
          meta:
            typeof result.meta === "object" && result.meta !== null ? (result.meta as Record<string, unknown>) : undefined,
          error: result.error,
        };
        await dependencies.sessionStore.appendEntry(sessionId, toolResultEntry);
        messages.push({
          role: "tool",
          content: formatToolMessageContent(result),
          messageId: createId("msg"),
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        });

        if (
          toolCall.name === "activate_skill" &&
          result.ok &&
          toolResultEntry.meta?.name &&
          toolResultEntry.meta?.contentHash &&
          toolResultEntry.meta.newlyActivated !== false
        ) {
          await dependencies.sessionStore.appendEntry(sessionId, {
            type: "skill_activation",
            skill: String(toolResultEntry.meta.name),
            contentHash: String(toolResultEntry.meta.contentHash),
            timestamp: new Date().toISOString(),
            runId: dependencies.runManager.runId,
          });
          await dependencies.runManager.recordSkillActivated(
            String(toolResultEntry.meta.name),
            typeof toolResultEntry.meta.rootDir === "string" ? toolResultEntry.meta.rootDir : undefined,
            typeof toolResultEntry.meta.resourceCount === "number" ? toolResultEntry.meta.resourceCount : undefined,
          );
        }

        await dependencies.runManager.recordToolCompleted(toolCall, result);
        if (invocationError !== null) {
          // MINOR: classify a bare middleware failure as INTERNAL_ERROR, not the catch-all MODEL_ERROR.
          if (isRuntimeError(invocationError)) throw invocationError;
          throw new RuntimeError({ code: "INTERNAL_ERROR", message: result.content });
        }
        if (result.error?.code === "RUN_ABORTED") {
          throw new RuntimeError(result.error);
        }
      }
    }
  } catch (error) {
    const runtimeError = isAbortError(error, dependencies.signal)
      ? new RuntimeError({
          code: "RUN_ABORTED",
          message: error instanceof Error ? error.message : "Run aborted by signal",
          retriable: true,
        }).toJSON()
      : toRuntimeErrorShape(error, isRuntimeError(error) ? error.code : "MODEL_ERROR");
    await dependencies.sessionStore.appendEntry(sessionId, {
      type: "error",
      timestamp: new Date().toISOString(),
      runId: dependencies.runManager.runId,
      error: runtimeError,
    });
    if (runtimeError.code === "RUN_ABORTED") {
      await dependencies.runManager.cancel(runtimeError);
    } else {
      await dependencies.runManager.fail(runtimeError);
    }
    throw error;
  }

  if (!finalMessage) {
    const assistantMessageId = createId("msg");
    finalMessage = {
      role: "assistant",
      content: createMaxTurnsHandoffMessage(dependencies.maxTurns),
      messageId: assistantMessageId,
    };
    messages.push(finalMessage);
    await dependencies.sessionStore.appendEntry(sessionId, {
      type: "message",
      role: "assistant",
      messageId: assistantMessageId,
      timestamp: new Date().toISOString(),
      content: finalMessage.content,
      runId: dependencies.runManager.runId,
    });
    await dependencies.runManager.recordTurnLimitReached(dependencies.maxTurns, finalMessage.content);
  }

  await dependencies.runManager.recordAssistantCompleted(finalMessage);
  await dependencies.runManager.complete();

  return {
    finalMessage,
    messages,
  };
}
