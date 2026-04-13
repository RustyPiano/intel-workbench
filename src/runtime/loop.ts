import type { ModelAdapter } from "../model/types.js";
import type { SessionStore } from "./session.js";
import type { AssistantMessage, RuntimeMessage, ToolCall, ToolResultEntry } from "./types.js";
import { createId } from "../utils/ids.js";
import type { ToolRegistry } from "../tools/index.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import { isRuntimeError, RuntimeError, toRuntimeErrorShape } from "./errors.js";
import type { RunManager } from "./run-manager.js";

export interface LoopDependencies {
  modelAdapter: ModelAdapter;
  toolRegistry: ToolRegistry;
  sessionStore: SessionStore;
  runManager: RunManager;
  signal?: AbortSignal;
  createSystemPrompt: () => Promise<string>;
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

function serializeToolResult(result: ToolExecutionResult): string {
  return JSON.stringify(result);
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

  try {
    while (turn < dependencies.maxTurns) {
      throwIfAborted(dependencies.signal);
      turn += 1;
      if (turn > 1) {
        await dependencies.runManager.emitPlanningSummary("progress", "Review tool results and plan the next step.");
      }

      const systemPrompt = await dependencies.createSystemPrompt();
      await dependencies.runManager.recordModelRequest(turn);
      const assistant = await dependencies.modelAdapter.generate({
        systemPrompt,
        messages,
        signal: dependencies.signal,
        tools: dependencies.toolRegistry.list().map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
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

        const result = await dependencies.toolRegistry.execute(toolCall, dependencies.createToolContext(toolCall));
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
          content: serializeToolResult(result),
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
    finalMessage = {
      role: "assistant",
      content: "Stopped after reaching the maximum turn limit.",
      messageId: createId("msg"),
    };
    messages.push(finalMessage);
    await dependencies.sessionStore.appendEntry(sessionId, {
      type: "message",
      role: "assistant",
      messageId: finalMessage.messageId!,
      timestamp: new Date().toISOString(),
      content: finalMessage.content,
      runId: dependencies.runManager.runId,
    });
  }

  await dependencies.runManager.recordAssistantCompleted(finalMessage);
  await dependencies.runManager.complete();

  return {
    finalMessage,
    messages,
  };
}
