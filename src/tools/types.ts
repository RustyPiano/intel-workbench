import type { RuntimeErrorShape } from "../runtime/errors.js";
import type { PolicyEngine } from "../runtime/policy.js";
import type { ActivatedSkill } from "../skills/registry.js";
import type { Logger } from "../utils/logger.js";
import type { FileMutationQueue } from "./file-mutation-queue.js";

export type JsonSchema = Record<string, unknown>;

export interface ToolArtifact {
  type: "log" | "file" | "json";
  path: string;
  description?: string;
}

export interface ToolExecutionResult<T = unknown> {
  ok: boolean;
  content: string;
  meta?: T;
  error?: RuntimeErrorShape;
  artifacts?: ToolArtifact[];
}

export interface ToolRuntimeConfig {
  toolTimeoutMs: number;
  bashTimeoutMs: number;
  maxBashOutputBytes: number;
  readMaxBytes: number;
}

export interface ToolContext {
  workspaceRoot: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  signal: AbortSignal;
  logger: Logger;
  skillRegistry?: {
    activate(name: string): Promise<ActivatedSkill>;
  };
  policy: PolicyEngine;
  config: ToolRuntimeConfig;
  fileMutationQueue?: FileMutationQueue;
  onUpdate?(partial: string): void;
}

export interface RuntimeTool<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(args: TArgs, ctx: ToolContext): Promise<ToolExecutionResult<TResult>>;
}
