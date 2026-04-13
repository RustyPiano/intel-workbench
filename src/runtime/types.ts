import type { RuntimeErrorShape } from "./errors.js";

export type RuntimeRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
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
}

export interface ToolResultEntry {
  type: "tool_result";
  toolCallId: string;
  ok: boolean;
  content: string;
  timestamp: string;
  data?: Record<string, unknown>;
  error?: RuntimeErrorShape;
}

export interface SkillActivationEntry {
  type: "skill_activation";
  skill: string;
  contentHash: string;
  timestamp: string;
}

export interface ErrorEntry {
  type: "error";
  timestamp: string;
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
