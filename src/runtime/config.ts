import { access, readFile } from "node:fs/promises";
import path from "node:path";

export interface RuntimeConfig {
  provider: string;
  model: string;
  baseURL?: string;
  apiKey?: string;
  smokeProvider?: string;
  smokeModel?: string;
  smokeBaseURL?: string;
  // Multimodal connection used by media tools (probe_media / analyze_media).
  // Kept separate from the primary text connection so a text model (e.g.
  // gpt-4.1) can drive the agent loop while an omni model (e.g.
  // qwen3.5-omni-plus on DashScope) handles audio/video understanding.
  // baseURL/apiKey fall back to the primary connection when omitted.
  mmProvider?: string;
  mmModel?: string;
  mmBaseURL?: string;
  mmApiKey?: string;
  // ASR connection used by dedicated audio transcription tools.
  // Kept separate from the primary text and multimodal connections because
  // Doubao ASR auth is not OpenAI-compatible.
  asrAppId?: string;
  asrApiKey?: string;
  asrAccessKey?: string;
  asrAppKey?: string;
  asrResourceId?: string;
  asrBaseURL?: string;
  tosAccessKeyId?: string;
  tosAccessKeySecret?: string;
  tosBucket?: string;
  tosRegion?: string;
  tosEndpoint?: string;
  tosPrefix?: string;
  tosSignedUrlExpires?: number;
  workspaceRoot: string;
  sessionDir: string;
  maxTurns: number;
  toolTimeoutMs: number;
  mmTimeoutMs?: number;
  asrTimeoutMs?: number;
  bashTimeoutMs: number;
  maxBashOutputBytes: number;
  readMaxBytes: number;
  globalSkillDirs: string[];
  explicitSkillDirs: string[];
  allowReadOutsideWorkspace: boolean;
  allowWriteOutsideWorkspace: boolean;
  traceMode: "compact" | "verbose" | "json";
  showPlan: boolean;
  hideDebug: boolean;
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
  tosPrefix: "mini-agent/uploads",
  tosSignedUrlExpires: 3600,
  globalSkillDirs: [],
  explicitSkillDirs: [],
  allowReadOutsideWorkspace: false,
  allowWriteOutsideWorkspace: false,
  traceMode: "compact",
  showPlan: true,
  hideDebug: false,
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

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : fallback;
}

function inferTosEndpoint(region: string | undefined): string | undefined {
  const normalizedRegion = region?.trim();
  if (!normalizedRegion) {
    return undefined;
  }
  return `tos-${normalizedRegion}.volces.com`;
}

function normalizeTosEndpoint(endpoint: string | undefined): string | undefined {
  const trimmed = endpoint?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return new URL(trimmed).host;
  } catch {
    return trimmed.replace(/^https?:\/\//iu, "").replace(/\/+$/u, "");
  }
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

function parseTraceMode(value: string | undefined): RuntimeConfig["traceMode"] | undefined {
  if (value === "compact" || value === "verbose" || value === "json") {
    return value;
  }

  return undefined;
}

function readEnvConfig(): Partial<RuntimeConfig> {
  const traceMode = parseTraceMode(process.env.MINI_AGENT_TRACE_MODE);
  const jsonEvents = parseBoolean(process.env.MINI_AGENT_JSON_EVENTS);
  const asrApiKey = process.env.MINI_AGENT_ASR_API_KEY;
  const asrAccessKey = process.env.MINI_AGENT_ASR_ACCESS_KEY;
  const asrAppKey = process.env.MINI_AGENT_ASR_APP_KEY;
  const asrConfigured = Boolean(asrApiKey || (asrAppKey && asrAccessKey));
  return {
    provider: process.env.MINI_AGENT_PROVIDER,
    model: process.env.MINI_AGENT_MODEL,
    baseURL: process.env.MINI_AGENT_BASE_URL,
    apiKey: process.env.MINI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY,
    smokeProvider: process.env.MINI_AGENT_SMOKE_PROVIDER,
    smokeModel: process.env.MINI_AGENT_SMOKE_MODEL,
    smokeBaseURL: process.env.MINI_AGENT_SMOKE_BASE_URL,
    mmProvider: process.env.MINI_AGENT_MM_PROVIDER,
    mmModel: process.env.MINI_AGENT_MM_MODEL,
    mmBaseURL: process.env.MINI_AGENT_MM_BASE_URL,
    mmApiKey: process.env.MINI_AGENT_MM_API_KEY,
    asrAppId: process.env.MINI_AGENT_ASR_APP_ID,
    asrApiKey,
    asrAccessKey,
    asrAppKey,
    asrResourceId: process.env.MINI_AGENT_ASR_RESOURCE_ID ?? (asrConfigured ? "volc.seedasr.auc" : undefined),
    asrBaseURL: process.env.MINI_AGENT_ASR_BASE_URL ?? (asrConfigured ? "https://openspeech.bytedance.com" : undefined),
    tosAccessKeyId: process.env.MINI_AGENT_TOS_ACCESS_KEY_ID,
    tosAccessKeySecret: process.env.MINI_AGENT_TOS_ACCESS_KEY_SECRET,
    tosBucket: process.env.MINI_AGENT_TOS_BUCKET,
    tosRegion: process.env.MINI_AGENT_TOS_REGION,
    tosEndpoint: process.env.MINI_AGENT_TOS_ENDPOINT,
    tosPrefix: process.env.MINI_AGENT_TOS_PREFIX,
    tosSignedUrlExpires: parsePositiveInteger(process.env.MINI_AGENT_TOS_SIGNED_URL_EXPIRES),
    sessionDir: process.env.MINI_AGENT_SESSION_DIR,
    maxTurns: parseNumber(process.env.MINI_AGENT_MAX_TURNS),
    toolTimeoutMs: parseNumber(process.env.MINI_AGENT_TOOL_TIMEOUT_MS),
    mmTimeoutMs: parsePositiveInteger(process.env.MINI_AGENT_MM_TIMEOUT_MS),
    asrTimeoutMs: parsePositiveInteger(process.env.MINI_AGENT_ASR_TIMEOUT_MS),
    bashTimeoutMs: parseNumber(process.env.MINI_AGENT_BASH_TIMEOUT_MS),
    maxBashOutputBytes: parseNumber(process.env.MINI_AGENT_MAX_BASH_OUTPUT_BYTES),
    readMaxBytes: parseNumber(process.env.MINI_AGENT_READ_MAX_BYTES),
    globalSkillDirs: parseList(process.env.MINI_AGENT_GLOBAL_SKILL_DIRS),
    allowReadOutsideWorkspace: parseBoolean(process.env.MINI_AGENT_ALLOW_READ_OUTSIDE_WORKSPACE),
    allowWriteOutsideWorkspace: parseBoolean(process.env.MINI_AGENT_ALLOW_WRITE_OUTSIDE_WORKSPACE),
    traceMode: traceMode ?? (jsonEvents ? "json" : undefined),
    showPlan: parseBoolean(process.env.MINI_AGENT_SHOW_PLAN),
    hideDebug: parseBoolean(process.env.MINI_AGENT_HIDE_DEBUG),
    jsonEventMode: jsonEvents,
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
  const asrConfigured = Boolean(merged.asrApiKey || (merged.asrAppKey && merged.asrAccessKey));
  const tosEndpoint = normalizeTosEndpoint(merged.tosEndpoint) ?? inferTosEndpoint(merged.tosRegion);

  return {
    ...merged,
    asrResourceId: merged.asrResourceId ?? (asrConfigured ? "volc.seedasr.auc" : undefined),
    asrBaseURL: merged.asrBaseURL ?? (asrConfigured ? "https://openspeech.bytedance.com" : undefined),
    tosEndpoint,
    tosSignedUrlExpires: normalizePositiveInteger(merged.tosSignedUrlExpires, DEFAULT_CONFIG.tosSignedUrlExpires ?? 3600),
    workspaceRoot: path.resolve(cwd, merged.workspaceRoot),
    sessionDir: merged.sessionDir,
    globalSkillDirs: merged.globalSkillDirs ?? [],
    explicitSkillDirs: merged.explicitSkillDirs ?? [],
    traceMode: merged.traceMode ?? (merged.jsonEventMode ? "json" : "compact"),
    showPlan: merged.showPlan ?? true,
    hideDebug: merged.hideDebug ?? false,
    jsonEventMode: merged.traceMode === "json" || merged.jsonEventMode,
  };
}
