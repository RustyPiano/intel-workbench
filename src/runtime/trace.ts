import type { RuntimeErrorShape } from "./errors.js";

export type RunStatus =
  | "pending"
  | "started"
  | "planning"
  | "executing"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

export type RunPhase = "planning" | "skill" | "tool" | "model" | "artifact" | "finalize" | "error" | "system";
export type RunLevel = "info" | "warn" | "error" | "debug";
export type RunHealth = "valid" | "degraded" | "corrupted";
export type RunLoadMode = "strict" | "recover";
export type RunErrorLayer =
  | "provider"
  | "model_adapter"
  | "session"
  | "skill"
  | "tool_validation"
  | "tool_execution"
  | "artifact"
  | "runtime"
  | "user_abort";

export interface RunEvent {
  schema_version: "v1.2";
  event_id: string;
  trace_id: string;
  run_id: string;
  session_id?: string;
  seq: number;
  ts: string;
  type: string;
  phase: RunPhase;
  level: RunLevel;
  summary: string;
  data?: Record<string, unknown>;
}

export interface RunMeta {
  run_id: string;
  trace_id: string;
  session_id?: string;
  status: RunStatus;
  started_at: string;
  ended_at?: string;
  provider?: string;
  model?: string;
  duration_ms?: number;
  tool_calls: number;
  skill_activations: number;
  artifact_count: number;
  first_error_code?: string;
}

export interface LoadedRunTrace {
  meta: RunMeta;
  events: RunEvent[];
  status: RunHealth;
  repairNotes: string[];
  tracePath: string;
  metaPath: string;
}

export interface RunFailure {
  error_code: string;
  error_layer: RunErrorLayer;
  user_message: string;
  debug_message: string;
  retriable?: boolean;
}

const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._-]+\b/giu,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/gu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /\b(?:api[_-]?key|token|secret|authorization)\s*[:=]\s*[^\s,;]+/giu,
];

export function redactSensitiveText(input: string): string {
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match) => {
      const separatorIndex = match.search(/[:=]/u);
      if (separatorIndex === -1) {
        if (/^Bearer\s+/iu.test(match)) {
          return "Bearer [REDACTED]";
        }
        return "[REDACTED]";
      }

      return `${match.slice(0, separatorIndex + 1)} [REDACTED]`;
    });
  }
  return output;
}

export function truncateText(input: string, maxLength = 120): string {
  if (input.length <= maxLength) {
    return input;
  }

  if (maxLength <= 3) {
    return input.slice(0, maxLength);
  }

  return `${input.slice(0, maxLength - 3)}...`;
}

export function createTraceSummary(input: string, maxLength = 120): string {
  const redacted = redactSensitiveText(input);
  const normalized = redacted.replace(/\s+/gu, " ").trim();
  return truncateText(normalized, maxLength);
}

export function previewValue(value: unknown, maxLength = 120): string {
  if (typeof value === "string") {
    return createTraceSummary(value, maxLength);
  }

  try {
    return createTraceSummary(JSON.stringify(value), maxLength);
  } catch {
    return createTraceSummary(String(value), maxLength);
  }
}

export function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) {
    return "unknown";
  }

  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`;
}

export function classifyRunFailure(error: RuntimeErrorShape): RunFailure {
  const providerCategory = typeof error.details?.category === "string" ? error.details.category : undefined;

  switch (error.code) {
    case "MODEL_ERROR":
      if (providerCategory === "auth") {
        return {
          error_code: "provider_auth_error",
          error_layer: "provider",
          user_message: "Provider authentication failed. Check your API key and endpoint settings.",
          debug_message: error.message,
          retriable: error.retriable,
        };
      }

      if (providerCategory === "quota") {
        return {
          error_code: "provider_quota_error",
          error_layer: "provider",
          user_message: "The provider rejected the request because quota or billing is exhausted.",
          debug_message: error.message,
          retriable: error.retriable,
        };
      }

      if (providerCategory === "unsupported_model") {
        return {
          error_code: "unsupported_model",
          error_layer: "provider",
          user_message: "The configured model is not supported by the current provider endpoint.",
          debug_message: error.message,
          retriable: error.retriable,
        };
      }

      if (providerCategory === "network") {
        return {
          error_code: "provider_network_error",
          error_layer: "provider",
          user_message: "The provider request failed on the network path. Check connectivity and base URL settings.",
          debug_message: error.message,
          retriable: true,
        };
      }

      return {
        error_code: "provider_error",
        error_layer: providerCategory ? "provider" : "model_adapter",
        user_message: "The model request failed before the agent could continue.",
        debug_message: error.message,
        retriable: error.retriable,
      };
    case "SESSION_CORRUPTED":
      return {
        error_code: "session_corrupted",
        error_layer: "session",
        user_message: "The session data is corrupted. Retry with a new session or recover the existing one.",
        debug_message: error.message,
      };
    case "SKILL_NOT_FOUND":
    case "SKILL_INVALID":
      return {
        error_code: "skill_not_found",
        error_layer: "skill",
        user_message: "The requested skill could not be loaded. Check the skill name and its files.",
        debug_message: error.message,
      };
    case "INVALID_ARGS":
      return {
        error_code: "tool_invalid_args",
        error_layer: "tool_validation",
        user_message: "A tool call was rejected because its arguments did not match the contract.",
        debug_message: error.message,
      };
    case "TOOL_TIMEOUT":
      return {
        error_code: "tool_timeout",
        error_layer: "tool_execution",
        user_message: "A tool timed out before it finished. Check the command, timeout, and generated logs.",
        debug_message: error.message,
        retriable: true,
      };
    case "PROCESS_EXIT_NONZERO":
      return {
        error_code: "tool_nonzero_exit",
        error_layer: "tool_execution",
        user_message: "The shell command failed. Check the command and its log file.",
        debug_message: error.message,
      };
    case "RUN_ABORTED":
      return {
        error_code: "run_aborted",
        error_layer: "user_abort",
        user_message: "The run was cancelled before it could finish.",
        debug_message: error.message,
        retriable: true,
      };
    case "FILE_NOT_FOUND":
      return {
        error_code: "artifact_missing",
        error_layer: "artifact",
        user_message: "A required file could not be found in the workspace.",
        debug_message: error.message,
      };
    default:
      return {
        error_code: "runtime_error",
        error_layer: "runtime",
        user_message: "The runtime stopped unexpectedly before the run could finish.",
        debug_message: error.message,
        retriable: error.retriable,
      };
  }
}
