import { z } from "zod";

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

export interface MultimodalToolConfig {
  provider: string;
  model: string;
  baseURL?: string;
  apiKey?: string;
}

export interface AsrToolConfig {
  baseURL: string;
  resourceId: string;
  appId?: string;
  apiKey?: string;
  accessKey?: string;
  appKey?: string;
  timeoutMs?: number;
  // Resource ID for the turbo (极速版) engine; defaults to volc.bigasr.auc_turbo.
  turboResourceId?: string;
  // Max raw audio bytes the turbo engine will base64-inline for a local file.
  turboMaxBytes?: number;
}

export interface TosStorageConfig {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  region: string;
  endpoint?: string;
  prefix: string;
  signedUrlExpires: number;
}

export interface ToolRuntimeConfig {
  toolTimeoutMs: number;
  mmTimeoutMs?: number;
  asrTimeoutMs?: number;
  bashTimeoutMs: number;
  maxBashOutputBytes: number;
  readMaxBytes: number;
  // Present only when a multimodal model is configured (mm* settings). Media
  // tools error with a clear message when this is absent.
  multimodal?: MultimodalToolConfig;
  // Present only when dedicated ASR credentials are configured. Audio tools do
  // not fall back to text or multimodal connections.
  asr?: AsrToolConfig;
  // Present only when TOS access key, secret, bucket, and region are configured.
  tos?: TosStorageConfig;
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
  inputSchema: z.ZodTypeAny;
  getTimeoutMs?(args: TArgs, ctx: ToolContext): number | undefined | Promise<number | undefined>;
  execute(args: TArgs, ctx: ToolContext): Promise<ToolExecutionResult<TResult>>;
}

/**
 * Force every declared property to appear in `required` and pin
 * `additionalProperties: false` recursively so the derived schema is
 * acceptable to OpenAI's strict tool-calling mode.
 *
 * OpenAI strict mode does not honour JSON Schema "optional" semantics; every
 * field listed in `properties` must be in `required`, and optional fields are
 * expected to accept `null`. zod's `.optional()` keys are excluded from the
 * derived `required` by default, so we widen them here.
 */
function widenTypeWithNull(schema: Record<string, unknown>): void {
  const currentType = schema.type;
  if (currentType === undefined) {
    return;
  }
  if (typeof currentType === "string") {
    if (currentType === "null") {
      return;
    }
    schema.type = [currentType, "null"];
    return;
  }
  if (Array.isArray(currentType)) {
    if (!currentType.includes("null")) {
      schema.type = [...currentType, "null"];
    }
  }
}

function enforceOpenAiStrict(node: unknown): void {
  if (!node || typeof node !== "object") {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      enforceOpenAiStrict(item);
    }
    return;
  }

  const object = node as Record<string, unknown>;

  if (object.type === "object" && object.properties && typeof object.properties === "object") {
    const properties = object.properties as Record<string, Record<string, unknown>>;
    const propertyNames = Object.keys(properties);
    const previousRequired = Array.isArray(object.required)
      ? new Set(object.required.map(String))
      : new Set<string>();

    if (propertyNames.length > 0) {
      object.required = propertyNames;
      for (const propertyName of propertyNames) {
        if (!previousRequired.has(propertyName)) {
          // The zod schema marked this field optional. OpenAI strict mode
          // requires every property be `required`, but those fields are
          // expected to accept `null` so callers can express absence.
          widenTypeWithNull(properties[propertyName]);
        }
      }
    }
    if (object.additionalProperties === undefined) {
      object.additionalProperties = false;
    }
    for (const value of Object.values(properties)) {
      enforceOpenAiStrict(value);
    }
  }

  for (const key of ["items", "anyOf", "oneOf", "allOf", "then", "else"] as const) {
    if (key in object) {
      enforceOpenAiStrict(object[key]);
    }
  }

  if (object.definitions && typeof object.definitions === "object") {
    for (const value of Object.values(object.definitions as Record<string, unknown>)) {
      enforceOpenAiStrict(value);
    }
  }
}

/**
 * Derive a JSON Schema from a tool's zod input schema, post-processed so
 * OpenAI's `strict: true` tool-calling accepts it (additionalProperties=false
 * and every declared property is required).
 *
 * Trade-off: the plan calls for `zod-to-json-schema`, but at the time of
 * writing the published `zod-to-json-schema@3.x` types and runtime are pinned
 * to zod v3's schema internals and silently produce an "any" placeholder when
 * fed zod v4 schemas. Zod v4 ships `z.toJSONSchema` natively, so we use that
 * and then run our own pass to satisfy OpenAI strict mode (no
 * `additionalProperties`, every declared property required).
 */
export function getToolJsonSchema(tool: RuntimeTool): JsonSchema {
  const derived = z.toJSONSchema(tool.inputSchema, {
    target: "draft-2020-12",
    io: "input",
  }) as JsonSchema;
  enforceOpenAiStrict(derived);
  // Drop `$schema` so the schema can be embedded inside an OpenAI tool spec
  // without leaking a JSON Schema dialect declaration the API does not expect.
  delete derived.$schema;
  return derived;
}
