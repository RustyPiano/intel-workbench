import path from "node:path";

import type { RuntimeConfig } from "../runtime/config.js";
import type { SessionStore } from "../runtime/session.js";
import type { RunMeta } from "../runtime/trace.js";

export interface DoctorSessionHealth {
  total: number;
  valid: number;
  degraded: number;
  corrupted: number;
}

export interface DoctorReportInput {
  workspaceRoot: string;
  sessionDir: string;
  skillDirs: string[];
  provider: string;
  model: string;
  baseURL?: string;
  apiKeyConfigured: boolean;
  skillCount: number;
  warnings: string[];
  sessionHealth: DoctorSessionHealth;
  smokePath: {
    configured: boolean;
    provider?: string;
    model?: string;
    baseURL?: string;
  };
  multimodalPath: {
    configured: boolean;
    provider?: string;
    model?: string;
    baseURL?: string;
    apiKeyConfigured: boolean;
    timeoutMs?: number;
  };
  asrPath: {
    configured: boolean;
    resourceId?: string;
    baseURL?: string;
    auth: "api-key" | "app-key+access-key" | "missing";
    timeoutMs?: number;
  };
  tosStorage: {
    configured: boolean;
    bucket?: string;
    region?: string;
    endpoint?: string;
    prefix?: string;
    signedUrlExpires?: number;
    accessKeyConfigured: boolean;
  };
  lastRun?: Partial<RunMeta> & {
    error_layer?: string;
    user_message?: string;
    trace_path?: string;
    artifacts_dir?: string;
    trace_status?: string;
  };
}

export async function collectSessionHealth(store: SessionStore): Promise<DoctorSessionHealth> {
  const sessions = await store.listSessions();
  let valid = 0;
  let degraded = 0;
  let corrupted = 0;

  for (const session of sessions) {
    const strict = await store.loadSession(session.sessionId, { mode: "strict" });
    if (strict.status === "valid") {
      valid += 1;
      continue;
    }

    const recovered = await store.loadSession(session.sessionId, { mode: "recover" });
    if (recovered.status === "degraded") {
      degraded += 1;
    } else {
      corrupted += 1;
    }
  }

  return {
    total: sessions.length,
    valid,
    degraded,
    corrupted,
  };
}

export function resolveDoctorSkillDirs(config: RuntimeConfig): string[] {
  return [
    path.join(config.workspaceRoot, ".agents", "skills"),
    ...config.explicitSkillDirs.map((skillDir) => path.resolve(config.workspaceRoot, skillDir)),
    ...config.globalSkillDirs.map((skillDir) => path.resolve(skillDir)),
  ];
}

export function formatDoctorReport(input: DoctorReportInput): string {
  const lines = [
    "[runtime_basics]",
    `workspace\t${input.workspaceRoot}`,
    `session_dir\t${input.sessionDir}`,
    `skill_dirs\t${input.skillDirs.join(",") || "(none)"}`,
    "",
    "[model_provider]",
    `provider\t${input.provider}`,
    `model\t${input.model}`,
    `base_url\t${input.baseURL ?? "(default OpenAI endpoint)"}`,
    `api_key\t${input.apiKeyConfigured ? "configured" : "missing"}`,
    "",
    "[skill_discovery]",
    `catalog_size\t${input.skillCount}`,
    `warnings\t${input.warnings.length}`,
    ...input.warnings.map((warning) => `warning\t${warning}`),
    "",
    "[session_health]",
    `total_sessions\t${input.sessionHealth.total}`,
    `valid_sessions\t${input.sessionHealth.valid}`,
    `degraded_sessions\t${input.sessionHealth.degraded}`,
    `corrupted_sessions\t${input.sessionHealth.corrupted}`,
    "",
    "[smoke_path]",
    `smoke_configured\t${input.smokePath.configured ? "yes" : "no"}`,
    `smoke_provider\t${input.smokePath.provider ?? "(unset)"}`,
    `smoke_model\t${input.smokePath.model ?? "(unset)"}`,
    `smoke_base_url\t${input.smokePath.baseURL ?? "(unset)"}`,
    "",
    "[multimodal_path]",
    `mm_configured\t${input.multimodalPath.configured ? "yes" : "no"}`,
    `mm_provider\t${input.multimodalPath.provider ?? "(unset)"}`,
    `mm_model\t${input.multimodalPath.model ?? "(unset)"}`,
    `mm_base_url\t${input.multimodalPath.baseURL ?? "(unset)"}`,
    `mm_api_key\t${input.multimodalPath.apiKeyConfigured ? "configured" : "missing"}`,
    `mm_timeout_ms\t${input.multimodalPath.timeoutMs ?? "(unset)"}`,
    "",
    "[asr_path]",
    `asr_configured\t${input.asrPath.configured ? "yes" : "no"}`,
    `asr_resource_id\t${input.asrPath.resourceId ?? "(unset)"}`,
    `asr_base_url\t${input.asrPath.baseURL ?? "(unset)"}`,
    `asr_auth\t${input.asrPath.auth}`,
    `asr_timeout_ms\t${input.asrPath.timeoutMs ?? "(unset)"}`,
    "",
    "[tos_storage]",
    `tos_configured\t${input.tosStorage.configured ? "yes" : "no"}`,
    `tos_bucket\t${input.tosStorage.bucket ?? "(unset)"}`,
    `tos_region\t${input.tosStorage.region ?? "(unset)"}`,
    `tos_endpoint\t${input.tosStorage.endpoint ?? "(unset)"}`,
    `tos_prefix\t${input.tosStorage.prefix ?? "(unset)"}`,
    `tos_signed_url_expires\t${input.tosStorage.signedUrlExpires ?? "(unset)"}`,
    `tos_access_key\t${input.tosStorage.accessKeyConfigured ? "configured" : "missing"}`,
  ];

  if (input.lastRun) {
    lines.push(
      "",
      "[last_run]",
      `run_id\t${input.lastRun.run_id ?? "(unknown)"}`,
      `status\t${input.lastRun.status ?? "(unknown)"}`,
      `provider\t${input.lastRun.provider ?? "(unknown)"}`,
      `model\t${input.lastRun.model ?? "(unknown)"}`,
      `duration_ms\t${input.lastRun.duration_ms ?? "(unknown)"}`,
      `tool_calls\t${input.lastRun.tool_calls ?? 0}`,
      `skill_activations\t${input.lastRun.skill_activations ?? 0}`,
      `artifact_count\t${input.lastRun.artifact_count ?? 0}`,
      `first_error_code\t${input.lastRun.first_error_code ?? "(none)"}`,
      `error_layer\t${input.lastRun.error_layer ?? "(none)"}`,
      `user_message\t${input.lastRun.user_message ?? "(none)"}`,
      `trace_status\t${input.lastRun.trace_status ?? "(unknown)"}`,
      `trace_path\t${input.lastRun.trace_path ?? "(unknown)"}`,
      `artifacts_dir\t${input.lastRun.artifacts_dir ?? "(unknown)"}`,
    );
  }

  return `${lines.join("\n")}\n`;
}
