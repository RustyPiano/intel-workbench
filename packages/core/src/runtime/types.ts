import type { RuntimeErrorShape } from "./errors.js";
import type { ToolArtifact } from "../tools/types.js";

export type RuntimeRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * 置位表示供应商返回的 tool call 参数无法解析为合法 JSON，且轻量修复也救不回。
   * 此时 `arguments` 被置为 `{}`；运行循环见此标记会跳过真实执行，直接合成一条失败的
   * tool result 反馈给模型，让它用合法 JSON 重发（截断时拆成更小的调用）。
   */
  argumentsParseError?: {
    /** 原始 `JSON.parse` 抛出的错误信息。 */
    message: string;
    /** 原始参数字符串的前若干字符（预览用，已截断）。 */
    rawArguments: string;
    /** 供应商 finish_reason 为 `length`（输出被截断）时为 true。 */
    truncated: boolean;
  };
}

export interface RuntimeMessage {
  role: RuntimeRole;
  content: string;
  messageId?: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ToolCall[];
}

export interface AssistantMessage extends RuntimeMessage {
  role: "assistant";
  toolCalls?: ToolCall[];
}

export interface SessionHeader {
  type: "session_header";
  version: 1;
  sessionId: string;
  createdAt: string;
  workspaceRoot: string;
  model: string;
  runtimeVersion: string;
}

export interface MessageEntry {
  type: "message";
  role: "user" | "assistant" | "tool" | "system";
  messageId: string;
  timestamp: string;
  content: string;
  runId?: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCallEntry {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  timestamp: string;
  runId?: string;
}

export interface ToolResultEntry {
  type: "tool_result";
  toolCallId: string;
  ok: boolean;
  content: string;
  timestamp: string;
  runId?: string;
  meta?: Record<string, unknown>;
  data?: Record<string, unknown>;
  error?: RuntimeErrorShape;
  artifacts?: ToolArtifact[];
}

export interface SkillActivationEntry {
  type: "skill_activation";
  skill: string;
  contentHash: string;
  timestamp: string;
  runId?: string;
}

export interface ErrorEntry {
  type: "error";
  timestamp: string;
  runId?: string;
  error: RuntimeErrorShape;
}

export interface EventEntry {
  type: "event";
  timestamp: string;
  event: Record<string, unknown>;
}

export type SessionEntry =
  | SessionHeader
  | MessageEntry
  | ToolCallEntry
  | ToolResultEntry
  | SkillActivationEntry
  | ErrorEntry
  | EventEntry;
