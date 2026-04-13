import type { ModelAdapter } from "../model/types.js";
import type { SessionStore } from "./session.js";
import type { AssistantMessage, RuntimeMessage, ToolCall, ToolResultEntry } from "./types.js";
import { createId } from "../utils/ids.js";
import type { ToolRegistry } from "../tools/index.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import type { EventBus } from "./events.js";
import { isRuntimeError, toRuntimeErrorShape } from "./errors.js";

export interface LoopDependencies {
  modelAdapter: ModelAdapter;
  toolRegistry: ToolRegistry;
  sessionStore: SessionStore;
  eventBus: EventBus;
  signal?: AbortSignal;
  createSystemPrompt: () => Promise<string>;
  createToolContext: (toolCall: ToolCall) => ToolContext;
  maxTurns: number;
}

export interface LoopResult {
  finalMessage: AssistantMessage;
  messages: RuntimeMessage[];
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
  });

  let turn = 0;
  let finalMessage: AssistantMessage | null = null;

  try {
    while (turn < dependencies.maxTurns) {
      turn += 1;
      dependencies.eventBus.emit({ type: "turn_start", turn });

      const systemPrompt = await dependencies.createSystemPrompt();
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
        toolCalls: assistantMessage.toolCalls,
      });

      if (!assistantMessage.toolCalls?.length) {
        finalMessage = assistantMessage;
        dependencies.eventBus.emit({ type: "turn_end", turn });
        break;
      }

      for (const toolCall of assistantMessage.toolCalls) {
        dependencies.eventBus.emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name });
        await dependencies.sessionStore.appendEntry(sessionId, {
          type: "tool_call",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: toolCall.arguments,
          timestamp: new Date().toISOString(),
        });

        const result = await dependencies.toolRegistry.execute(toolCall, dependencies.createToolContext(toolCall));
        const toolResultEntry: ToolResultEntry = {
          type: "tool_result",
          toolCallId: toolCall.id,
          ok: result.ok,
          content: result.content,
          timestamp: new Date().toISOString(),
          data:
            typeof result.data === "object" && result.data !== null ? (result.data as Record<string, unknown>) : undefined,
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
          toolResultEntry.data?.name &&
          toolResultEntry.data?.contentHash &&
          toolResultEntry.data.newlyActivated !== false
        ) {
          await dependencies.sessionStore.appendEntry(sessionId, {
            type: "skill_activation",
            skill: String(toolResultEntry.data.name),
            contentHash: String(toolResultEntry.data.contentHash),
            timestamp: new Date().toISOString(),
          });
          dependencies.eventBus.emit({ type: "skill_activation", name: String(toolResultEntry.data.name) });
        }

        dependencies.eventBus.emit({ type: "tool_execution_end", toolCallId: toolCall.id, ok: result.ok });
      }

      dependencies.eventBus.emit({ type: "turn_end", turn });
    }
  } catch (error) {
    const runtimeError = toRuntimeErrorShape(error, isRuntimeError(error) ? error.code : "MODEL_ERROR");
    await dependencies.sessionStore.appendEntry(sessionId, {
      type: "error",
      timestamp: new Date().toISOString(),
      error: runtimeError,
    });
    dependencies.eventBus.emit({ type: "runtime_error", error: runtimeError });
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
    });
  }

  return {
    finalMessage,
    messages,
  };
}
