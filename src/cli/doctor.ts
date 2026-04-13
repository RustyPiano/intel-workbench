import path from "node:path";

import type { RuntimeConfig } from "../runtime/config.js";
import type { SessionStore } from "../runtime/session.js";

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
  ];

  return `${lines.join("\n")}\n`;
}
