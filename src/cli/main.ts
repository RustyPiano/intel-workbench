#!/usr/bin/env node

import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { collectSessionHealth, formatDoctorReport, resolveDoctorSkillDirs } from "./doctor.js";
import { formatRunTraceReport, formatSessionTraceReport } from "./run-report.js";
import { renderTimeline } from "./timeline.js";
import { createModelAdapter } from "../model/factory.js";
import { RuntimeAgent } from "../runtime/agent.js";
import { resolveRuntimeConfig, type RuntimeConfig } from "../runtime/config.js";
import { RunStore } from "../runtime/run-store.js";
import { SessionStore } from "../runtime/session.js";
import { createTraceSummary, type LoadedRunTrace, type RunMeta } from "../runtime/trace.js";
import { RUNTIME_VERSION } from "../runtime/version.js";
import { SkillRegistry } from "../skills/registry.js";
import { startRepl } from "./repl.js";

interface ParsedArgs {
  prompt?: string;
  command?: string[];
  overrides: Partial<RuntimeConfig>;
  help: boolean;
}

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

const SUBCOMMANDS = new Set(["skills", "run", "session", "doctor"]);

function isFlagLike(token: string | undefined): boolean {
  if (typeof token !== "string") {
    return false;
  }
  return token.startsWith("--");
}

function requireValue(argv: string[], idx: number, flag: string): string {
  const value = argv[idx];
  if (typeof value !== "string" || value.length === 0 || isFlagLike(value)) {
    throw new CliError(`Missing value for ${flag}`);
  }
  return value;
}

function parseTraceMode(value: string): "compact" | "verbose" | "json" {
  if (value === "compact" || value === "verbose" || value === "json") {
    return value;
  }
  throw new CliError(`Invalid value for --trace: '${value}'. Expected compact|verbose|json.`);
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError(`Invalid value for ${flag}: '${value}'. Expected a positive integer.`);
  }
  return parsed;
}

function printHelp(): void {
  console.log(`mini-agent [prompt]
  --cwd <path>
  --provider <name>
  --model <name>
  --base-url <url>
  --api-key <token>
  --session <id>
  --skill-dir <path>
  --trace compact|verbose|json
  --show-plan
  --hide-debug
  --json-events
  --read-only
  --max-turns <n>
  --help

Commands:
  mini-agent skills list
  mini-agent run list
  mini-agent run show <id> [--format timeline|json|jsonl|markdown] [--verbose] [--recover]
  mini-agent session list
  mini-agent session show <id> [--recover] [--trace] [--run <id>]
  mini-agent doctor [--last-run | --run <id>]`);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const overrides: Partial<RuntimeConfig> = {
    explicitSkillDirs: [],
  };
  const positionals: string[] = [];
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== "string" || arg.length === 0) {
      continue;
    }

    switch (arg) {
      case "--cwd":
        overrides.workspaceRoot = requireValue(argv, ++index, "--cwd");
        break;
      case "--model":
        overrides.model = requireValue(argv, ++index, "--model");
        break;
      case "--provider":
        overrides.provider = requireValue(argv, ++index, "--provider");
        break;
      case "--base-url":
        overrides.baseURL = requireValue(argv, ++index, "--base-url");
        break;
      case "--api-key":
        overrides.apiKey = requireValue(argv, ++index, "--api-key");
        break;
      case "--session":
        overrides.sessionId = requireValue(argv, ++index, "--session");
        break;
      case "--skill-dir": {
        const value = requireValue(argv, ++index, "--skill-dir");
        overrides.explicitSkillDirs = [...(overrides.explicitSkillDirs ?? []), value];
        break;
      }
      case "--trace": {
        const value = requireValue(argv, ++index, "--trace");
        overrides.traceMode = parseTraceMode(value);
        break;
      }
      case "--show-plan":
        overrides.showPlan = true;
        break;
      case "--hide-debug":
        overrides.hideDebug = true;
        break;
      case "--json-events":
        overrides.traceMode = "json";
        overrides.jsonEventMode = true;
        break;
      case "--read-only":
        overrides.readOnly = true;
        break;
      case "--max-turns": {
        const value = requireValue(argv, ++index, "--max-turns");
        overrides.maxTurns = parsePositiveInt(value, "--max-turns");
        break;
      }
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        if (arg.startsWith("--")) {
          // Unknown top-level flag — but only reject before a subcommand has
          // been seen. Subcommands (run / session / doctor) carry their own
          // flag vocabulary that we forward verbatim through positionals.
          const seenSubcommand = SUBCOMMANDS.has(positionals[0] ?? "");
          if (!seenSubcommand) {
            throw new CliError(`Unknown flag: ${arg}`);
          }
        }
        positionals.push(arg);
        break;
    }
  }

  const isCommand = SUBCOMMANDS.has(positionals[0] ?? "");
  return {
    help,
    overrides,
    command: isCommand ? positionals : undefined,
    prompt: isCommand ? undefined : positionals.join(" ").trim() || undefined,
  };
}

function commandValue(command: string[], flag: string): string | undefined {
  const index = command.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return command[index + 1];
}

function timelineMode(config: RuntimeConfig, command: string[] = []): "compact" | "verbose" {
  if (command.includes("--verbose")) {
    return "verbose";
  }

  return config.traceMode === "verbose" ? "verbose" : "compact";
}

async function handleSkillsCommand(config: RuntimeConfig): Promise<void> {
  const registry = await SkillRegistry.discover({
    workspaceRoot: config.workspaceRoot,
    explicitSkillDirs: config.explicitSkillDirs,
    globalSkillDirs: config.globalSkillDirs,
  });

  for (const skill of registry.getCatalog()) {
    console.log(`${skill.name}\t${skill.description}`);
  }
}

async function handleRunCommand(config: RuntimeConfig, command: string[]): Promise<void> {
  const store = new RunStore({ workspaceRoot: config.workspaceRoot });

  if (command[1] === "list") {
    const runs = await store.listRuns();
    for (const run of runs) {
      console.log(`${run.run_id}\t${run.status}\t${run.started_at}\t${run.model ?? "(unknown model)"}`);
    }
    return;
  }

  if (command[1] === "show" && command[2]) {
    const format = (commandValue(command, "--format") ?? "timeline") as "timeline" | "json" | "jsonl" | "markdown";
    const trace = await store.loadTrace(command[2], {
      mode: command.includes("--recover") ? "recover" : "strict",
    });
    process.stdout.write(
      formatRunTraceReport(trace, {
        format,
        mode: timelineMode(config, command),
        showPlan: config.showPlan,
        hideDebug: config.hideDebug,
      }),
    );
    return;
  }

  throw new Error("Unknown run command. Use `run list` or `run show <id>`.");
}

async function handleSessionCommand(config: RuntimeConfig, command: string[]): Promise<void> {
  const store = new SessionStore({
    workspaceRoot: config.workspaceRoot,
    runtimeVersion: RUNTIME_VERSION,
    model: config.model,
    sessionDir: config.sessionDir,
  });

  if (command[1] === "list") {
    const sessions = await store.listSessions();
    for (const session of sessions) {
      console.log(`${session.sessionId}\t${session.path}`);
    }
    return;
  }

  if (command[1] === "show" && command[2]) {
    const session = await store.loadSession(command[2], {
      mode: command.includes("--recover") ? "recover" : "strict",
    });

    if (command.includes("--trace")) {
      const runStore = new RunStore({ workspaceRoot: config.workspaceRoot });
      const requestedRunId = commandValue(command, "--run");
      const runIds = requestedRunId
        ? [requestedRunId]
        : [...new Set(session.entries.flatMap((entry) => ("runId" in entry && entry.runId ? [entry.runId] : [])))];
      const runTraces = (
        await Promise.all(
          runIds.map(async (runId) => {
            try {
              return await runStore.loadTrace(runId, {
                mode: command.includes("--recover") ? "recover" : "strict",
              });
            } catch (error) {
              return {
                meta: {
                  run_id: runId,
                  trace_id: `missing_${runId}`,
                  session_id: session.header?.sessionId ?? command[2],
                  status: "failed",
                  started_at: new Date(0).toISOString(),
                  tool_calls: 0,
                  skill_activations: 0,
                  artifact_count: 0,
                },
                events: [],
                status: "corrupted",
                repairNotes: [`trace load failed: ${error instanceof Error ? error.message : "unknown error"}`],
                tracePath: "",
                metaPath: "",
              } satisfies LoadedRunTrace;
            }
          }),
        )
      );

      process.stdout.write(
        formatSessionTraceReport(
          {
            sessionId: session.header?.sessionId ?? command[2],
            sessionStatus: session.status,
            runTraces,
          },
          {
            mode: timelineMode(config, command),
            showPlan: config.showPlan,
            hideDebug: config.hideDebug,
          },
        ),
      );
      return;
    }

    console.log(JSON.stringify(session.header, null, 2));
    console.log(`status\t${session.status}`);
    for (const entry of session.entries) {
      console.log(JSON.stringify(entry, null, 2));
    }
    if (session.repairReportPath) {
      console.log(`repair-report\t${session.repairReportPath}`);
    }
    return;
  }

  throw new Error("Unknown session command. Use `session list` or `session show <id>`.");
}

async function handleDoctorCommand(config: RuntimeConfig, command: string[] = []): Promise<void> {
  const registry = await SkillRegistry.discover({
    workspaceRoot: config.workspaceRoot,
    explicitSkillDirs: config.explicitSkillDirs,
    globalSkillDirs: config.globalSkillDirs,
  });
  const sessionStore = new SessionStore({
    workspaceRoot: config.workspaceRoot,
    runtimeVersion: RUNTIME_VERSION,
    model: config.model,
    sessionDir: config.sessionDir,
  });
  const sessionHealth = await collectSessionHealth(sessionStore);
  const runStore = new RunStore({ workspaceRoot: config.workspaceRoot });
  const requestedRunId = commandValue(command, "--run");
  const lastRun = requestedRunId
    ? await (async () => {
        const meta = await runStore.loadMeta(requestedRunId).catch(() => undefined);
        if (!meta) {
          return undefined;
        }
        const trace = await runStore.loadTrace(requestedRunId, { mode: "recover" }).catch(() => undefined);
        const terminalEvent = trace?.events.at(-1);
        return {
          ...meta,
          error_layer: typeof terminalEvent?.data?.error_layer === "string" ? terminalEvent.data.error_layer : undefined,
          user_message: typeof terminalEvent?.data?.user_message === "string" ? terminalEvent.data.user_message : undefined,
          trace_status: trace?.status,
          trace_path: trace?.tracePath,
          artifacts_dir: await runStore.getArtifactsDir(requestedRunId).catch(() => undefined),
        };
      })()
    : command.includes("--last-run")
      ? ((await runStore.readLastRun()) as Partial<RunMeta> | null) ?? undefined
      : undefined;

  process.stdout.write(
    formatDoctorReport({
      workspaceRoot: config.workspaceRoot,
      sessionDir: path.resolve(config.workspaceRoot, config.sessionDir),
      skillDirs: resolveDoctorSkillDirs(config),
      provider: config.provider,
      model: config.model,
      baseURL: config.baseURL,
      apiKeyConfigured: Boolean(config.apiKey),
      skillCount: registry.getCatalog().length,
      warnings: registry.warnings,
      sessionHealth,
      smokePath: {
        configured: Boolean(config.smokeProvider || config.smokeModel || config.smokeBaseURL),
        provider: config.smokeProvider,
        model: config.smokeModel,
        baseURL: config.smokeBaseURL,
      },
      lastRun,
    }),
  );
}

function createRuntimeAgent(config: RuntimeConfig): RuntimeAgent {
  const adapter = createModelAdapter({
    provider: config.provider,
    model: config.model,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });

  return new RuntimeAgent({
    workspaceRoot: config.workspaceRoot,
    runtimeVersion: RUNTIME_VERSION,
    modelName: config.model,
    providerName: config.provider,
    modelAdapter: adapter,
    explicitSkillDirs: config.explicitSkillDirs.map((skillDir) => path.resolve(config.workspaceRoot, skillDir)),
    globalSkillDirs: config.globalSkillDirs,
    maxTurns: config.maxTurns,
    readOnly: config.readOnly,
    allowReadOutsideWorkspace: config.allowReadOutsideWorkspace,
    allowWriteOutsideWorkspace: config.allowWriteOutsideWorkspace,
    sessionDir: config.sessionDir,
    toolConfig: {
      toolTimeoutMs: config.toolTimeoutMs,
      bashTimeoutMs: config.bashTimeoutMs,
      maxBashOutputBytes: config.maxBashOutputBytes,
      readMaxBytes: config.readMaxBytes,
    },
  });
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    return;
  }

  const config = await resolveRuntimeConfig({
    cwd: process.cwd(),
    cliOverrides: parsed.overrides,
  });

  if (parsed.command?.[0] === "skills" && parsed.command[1] === "list") {
    await handleSkillsCommand(config);
    return;
  }

  if (parsed.command?.[0] === "run") {
    await handleRunCommand(config, parsed.command);
    return;
  }

  if (parsed.command?.[0] === "session") {
    await handleSessionCommand(config, parsed.command);
    return;
  }

  if (parsed.command?.[0] === "doctor") {
    await handleDoctorCommand(config, parsed.command);
    return;
  }

  const agent = createRuntimeAgent(config);
  if (config.traceMode === "json") {
    agent.eventBus.subscribe((event) => {
      console.log(JSON.stringify(event));
    });
  } else {
    agent.eventBus.subscribe((event) => {
      const lines = renderTimeline([event], {
        mode: config.traceMode === "verbose" ? "verbose" : "compact",
        showPlan: config.showPlan,
        hideDebug: config.hideDebug,
      });
      for (const line of lines) {
        console.log(line);
      }
    });
  }

  if (parsed.prompt) {
    const conversation = await agent.createConversation(config.sessionId);
    const result = await conversation.send(parsed.prompt);
    const summary = createTraceSummary(result.finalMessage.content);
    if (
      config.traceMode !== "json" &&
      result.finalMessage.content &&
      (result.finalMessage.content.includes("\n") || summary !== result.finalMessage.content)
    ) {
      console.log("");
      console.log(result.finalMessage.content);
    }
    return;
  }

  await startRepl({
    agent,
    sessionId: config.sessionId,
    traceMode: config.traceMode,
    showPlan: config.showPlan,
    hideDebug: config.hideDebug,
  });
}

const isDirectInvocation = (() => {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    const modulePath = fileURLToPath(import.meta.url);
    if (modulePath === entry) {
      return true;
    }
    return realpathSync(entry) === modulePath;
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main().catch((error) => {
    if (error instanceof CliError) {
      printHelp();
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
