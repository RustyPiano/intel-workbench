import { access, readFile } from "node:fs/promises";
import path from "node:path";

export interface RuntimeConfig {
  provider: string;
  model: string;
  baseURL?: string;
  apiKey?: string;
  workspaceRoot: string;
  sessionDir: string;
  maxTurns: number;
  toolTimeoutMs: number;
  bashTimeoutMs: number;
  maxBashOutputBytes: number;
  readMaxBytes: number;
  globalSkillDirs: string[];
  explicitSkillDirs: string[];
  allowReadOutsideWorkspace: boolean;
  allowWriteOutsideWorkspace: boolean;
  jsonEventMode: boolean;
  readOnly: boolean;
  sessionId?: string;
}

export interface ResolveConfigOptions {
  cwd?: string;
  cliOverrides?: Partial<RuntimeConfig>;
}

const DEFAULT_CONFIG: RuntimeConfig = {
  provider: "openai-compatible",
  model: "gpt-4.1",
  workspaceRoot: ".",
  sessionDir: ".mini-agent/sessions",
  maxTurns: 12,
  toolTimeoutMs: 60_000,
  bashTimeoutMs: 120_000,
  maxBashOutputBytes: 64 * 1024,
  readMaxBytes: 256 * 1024,
  globalSkillDirs: [],
  explicitSkillDirs: [],
  allowReadOutsideWorkspace: false,
  allowWriteOutsideWorkspace: false,
  jsonEventMode: false,
  readOnly: false,
};

async function loadConfigFile(workspaceRoot: string): Promise<Partial<RuntimeConfig>> {
  const configPath = path.join(workspaceRoot, "mini-agent.config.json");

  try {
    await access(configPath);
  } catch {
    return {};
  }

  const parsed = JSON.parse(await readFile(configPath, "utf8")) as Partial<RuntimeConfig>;
  return parsed;
}

function stripUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value === "1" || value.toLowerCase() === "true";
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readEnvConfig(): Partial<RuntimeConfig> {
  return {
    provider: process.env.MINI_AGENT_PROVIDER,
    model: process.env.MINI_AGENT_MODEL,
    baseURL: process.env.MINI_AGENT_BASE_URL,
    apiKey: process.env.MINI_AGENT_API_KEY,
    sessionDir: process.env.MINI_AGENT_SESSION_DIR,
    maxTurns: parseNumber(process.env.MINI_AGENT_MAX_TURNS),
    toolTimeoutMs: parseNumber(process.env.MINI_AGENT_TOOL_TIMEOUT_MS),
    bashTimeoutMs: parseNumber(process.env.MINI_AGENT_BASH_TIMEOUT_MS),
    maxBashOutputBytes: parseNumber(process.env.MINI_AGENT_MAX_BASH_OUTPUT_BYTES),
    readMaxBytes: parseNumber(process.env.MINI_AGENT_READ_MAX_BYTES),
    globalSkillDirs: parseList(process.env.MINI_AGENT_GLOBAL_SKILL_DIRS),
    allowReadOutsideWorkspace: parseBoolean(process.env.MINI_AGENT_ALLOW_READ_OUTSIDE_WORKSPACE),
    allowWriteOutsideWorkspace: parseBoolean(process.env.MINI_AGENT_ALLOW_WRITE_OUTSIDE_WORKSPACE),
    jsonEventMode: parseBoolean(process.env.MINI_AGENT_JSON_EVENTS),
    readOnly: parseBoolean(process.env.MINI_AGENT_READ_ONLY),
  };
}

export async function resolveRuntimeConfig(options: ResolveConfigOptions = {}): Promise<RuntimeConfig> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const cliWorkspaceRoot = options.cliOverrides?.workspaceRoot
    ? path.resolve(cwd, options.cliOverrides.workspaceRoot)
    : cwd;
  const fileConfig = await loadConfigFile(cliWorkspaceRoot);
  const envConfig = stripUndefined(readEnvConfig());
  const merged = {
    ...DEFAULT_CONFIG,
    ...stripUndefined(fileConfig),
    ...envConfig,
    ...stripUndefined(options.cliOverrides ?? {}),
  } as RuntimeConfig;

  return {
    ...merged,
    workspaceRoot: path.resolve(cwd, merged.workspaceRoot),
    sessionDir: merged.sessionDir,
    globalSkillDirs: merged.globalSkillDirs ?? [],
    explicitSkillDirs: merged.explicitSkillDirs ?? [],
  };
}
