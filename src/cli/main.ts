#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import { collectSessionHealth, formatDoctorReport, resolveDoctorSkillDirs } from "./doctor.js";
import { createModelAdapter } from "../model/factory.js";
import { RuntimeAgent } from "../runtime/agent.js";
import { resolveRuntimeConfig, type RuntimeConfig } from "../runtime/config.js";
import { SessionStore } from "../runtime/session.js";
import { SkillRegistry } from "../skills/registry.js";
import { startRepl } from "./repl.js";

interface ParsedArgs {
  prompt?: string;
  command?: string[];
  overrides: Partial<RuntimeConfig>;
  help: boolean;
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
  --json-events
  --read-only
  --max-turns <n>
  --help

Commands:
  mini-agent skills list
  mini-agent session list
  mini-agent session show <id> [--recover]
  mini-agent doctor`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const overrides: Partial<RuntimeConfig> = {
    explicitSkillDirs: [],
  };
  const positionals: string[] = [];
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    switch (arg) {
      case "--cwd":
        overrides.workspaceRoot = argv[++index];
        break;
      case "--model":
        overrides.model = argv[++index];
        break;
      case "--provider":
        overrides.provider = argv[++index];
        break;
      case "--base-url":
        overrides.baseURL = argv[++index];
        break;
      case "--api-key":
        overrides.apiKey = argv[++index];
        break;
      case "--session":
        overrides.sessionId = argv[++index];
        break;
      case "--skill-dir":
        overrides.explicitSkillDirs = [...(overrides.explicitSkillDirs ?? []), argv[++index] ?? ""].filter(Boolean);
        break;
      case "--json-events":
        overrides.jsonEventMode = true;
        break;
      case "--read-only":
        overrides.readOnly = true;
        break;
      case "--max-turns":
        overrides.maxTurns = Number(argv[++index]);
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        positionals.push(arg);
        break;
    }
  }

  const isCommand = positionals[0] === "skills" || positionals[0] === "session" || positionals[0] === "doctor";
  return {
    help,
    overrides,
    command: isCommand ? positionals : undefined,
    prompt: isCommand ? undefined : positionals.join(" ").trim() || undefined,
  };
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

async function handleSessionCommand(config: RuntimeConfig, command: string[]): Promise<void> {
  const store = new SessionStore({
    workspaceRoot: config.workspaceRoot,
    runtimeVersion: "1.0.0",
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

async function handleDoctorCommand(config: RuntimeConfig): Promise<void> {
  const registry = await SkillRegistry.discover({
    workspaceRoot: config.workspaceRoot,
    explicitSkillDirs: config.explicitSkillDirs,
    globalSkillDirs: config.globalSkillDirs,
  });
  const sessionStore = new SessionStore({
    workspaceRoot: config.workspaceRoot,
    runtimeVersion: "1.0.0",
    model: config.model,
    sessionDir: config.sessionDir,
  });
  const sessionHealth = await collectSessionHealth(sessionStore);

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
    runtimeVersion: "1.0.0",
    modelName: config.model,
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

  if (parsed.command?.[0] === "session") {
    await handleSessionCommand(config, parsed.command);
    return;
  }

  if (parsed.command?.[0] === "doctor") {
    await handleDoctorCommand(config);
    return;
  }

  const agent = createRuntimeAgent(config);
  if (config.jsonEventMode) {
    agent.eventBus.subscribe((event) => {
      console.log(JSON.stringify(event));
    });
  }

  if (parsed.prompt) {
    const conversation = await agent.createConversation(config.sessionId);
    const result = await conversation.send(parsed.prompt);
    if (result.finalMessage.content) {
      console.log(result.finalMessage.content);
    }
    agent.eventBus.emit({ type: "agent_end", sessionId: conversation.sessionId });
    return;
  }

  await startRepl({
    agent,
    sessionId: config.sessionId,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
