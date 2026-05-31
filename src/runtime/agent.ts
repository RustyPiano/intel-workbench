import path from "node:path";

import type { ModelAdapter } from "../model/types.js";
import { SkillRegistry } from "../skills/registry.js";
import { createDefaultToolRegistry } from "../tools/index.js";
import { FileMutationQueue } from "../tools/file-mutation-queue.js";
import type { ToolExecutionResult, ToolRuntimeConfig } from "../tools/types.js";
import { createConsoleLogger, type Logger } from "../utils/logger.js";
import { RuntimeError } from "./errors.js";
import { EventBus } from "./events.js";
import { formatToolMessageContent, runAgentLoop } from "./loop.js";
import { createPolicyEngine, type PolicyEngine } from "./policy.js";
import { buildActiveSkillsBlock, buildBaseSystemPrompt } from "./prompt.js";
import { RunManager } from "./run-manager.js";
import { RunStore } from "./run-store.js";
import { SessionStore } from "./session.js";
import type { AssistantMessage, RuntimeMessage, SessionEntry } from "./types.js";

export interface RuntimeAgentOptions {
  workspaceRoot: string;
  runtimeVersion: string;
  modelName: string;
  providerName?: string;
  modelAdapter: ModelAdapter;
  explicitSkillDirs?: string[];
  globalSkillDirs?: string[];
  maxTurns?: number;
  readOnly?: boolean;
  allowReadOutsideWorkspace?: boolean;
  allowWriteOutsideWorkspace?: boolean;
  sessionDir?: string;
  toolConfig?: ToolRuntimeConfig;
  logger?: Logger;
}

export interface RuntimeRunResult {
  runId: string;
  sessionId: string;
  sessionPath: string;
  finalMessage: AssistantMessage;
}

export class RuntimeConversation {
  private messages: RuntimeMessage[];
  // Serialize concurrent send() invocations so the shared `messages` array
  // cannot be mutated by overlapping turns. Failures are swallowed for the
  // queue tail so a single rejection does not block subsequent sends; callers
  // still receive their own rejection through the returned promise.
  private sendQueue: Promise<unknown> = Promise.resolve();
  // Per-conversation cache of the base system prompt. AGENTS.md and the skill
  // catalog do not change for the lifetime of a conversation, so we build the
  // base once and reuse it across every send().
  private cachedBaseSystemPrompt: Promise<string> | null = null;

  constructor(
    private readonly agent: RuntimeAgent,
    readonly sessionId: string,
    readonly sessionPath: string,
    messages: RuntimeMessage[] = [],
    private resumedFromStore = false,
  ) {
    this.messages = messages;
  }

  send(prompt: string, signal: AbortSignal = new AbortController().signal): Promise<RuntimeRunResult> {
    const next = this.sendQueue.then(() => this.sendInternal(prompt, signal));
    this.sendQueue = next.catch(() => {});
    return next;
  }

  private getBaseSystemPrompt(): Promise<string> {
    if (this.cachedBaseSystemPrompt === null) {
      this.cachedBaseSystemPrompt = buildBaseSystemPrompt({
        workspaceRoot: this.agent.workspaceRoot,
        availableSkills: this.agent.skillRegistry.getCatalog(),
      });
    }
    return this.cachedBaseSystemPrompt;
  }

  private async sendInternal(prompt: string, signal: AbortSignal): Promise<RuntimeRunResult> {
    const runManager = await RunManager.start({
      workspaceRoot: this.agent.workspaceRoot,
      sessionId: this.sessionId,
      provider: this.agent.providerName,
      model: this.agent.modelName,
      eventBus: this.agent.eventBus,
      runStore: this.agent.runStore,
      prompt,
      maxTurns: this.agent.maxTurns,
      resumedFromSession: this.resumedFromStore,
    });

    const loopResult = await runAgentLoop(prompt, this.sessionId, {
      modelAdapter: this.agent.modelAdapter,
      toolRegistry: this.agent.toolRegistry,
      sessionStore: this.agent.sessionStore,
      signal,
      maxTurns: this.agent.maxTurns,
      runManager,
      createBaseSystemPrompt: () => this.getBaseSystemPrompt(),
      createActiveSkillsBlock: () => buildActiveSkillsBlock(this.agent.skillRegistry.getActiveRecords()),
      getActiveSkillNames: () => this.agent.skillRegistry.getActiveRecords().map((skill) => skill.meta.name),
      createToolContext: (toolCall) => ({
        workspaceRoot: this.agent.workspaceRoot,
        sessionId: this.sessionId,
        runId: runManager.runId,
        toolCallId: toolCall.id,
        signal,
        logger: this.agent.logger,
        skillRegistry: this.agent.skillRegistry,
        policy: this.agent.policy,
        fileMutationQueue: this.agent.fileMutationQueue,
        config: this.agent.toolConfig,
        onUpdate: (partial) =>
          void runManager.recordToolProgress(toolCall, partial),
      }),
    }, this.messages);

    this.messages = loopResult.messages;
    this.resumedFromStore = false;

    return {
      runId: runManager.runId,
      sessionId: this.sessionId,
      sessionPath: this.sessionPath,
      finalMessage: loopResult.finalMessage,
    };
  }
}

export class RuntimeAgent {
  readonly workspaceRoot: string;
  readonly runtimeVersion: string;
  readonly modelName: string;
  readonly providerName: string;
  readonly modelAdapter: ModelAdapter;
  readonly logger: Logger;
  readonly eventBus = new EventBus();
  readonly sessionStore: SessionStore;
  readonly runStore: RunStore;
  readonly maxTurns: number;
  readonly toolConfig: ToolRuntimeConfig;
  readonly toolRegistry = createDefaultToolRegistry();
  readonly fileMutationQueue = new FileMutationQueue();
  readonly skillRegistry: SkillRegistry;
  readonly policy: PolicyEngine;

  private constructor(
    options: RuntimeAgentOptions,
    skillRegistry: SkillRegistry,
    policy: PolicyEngine,
  ) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.runtimeVersion = options.runtimeVersion;
    this.modelName = options.modelName;
    this.providerName = options.providerName ?? "openai-compatible";
    this.modelAdapter = options.modelAdapter;
    this.logger = options.logger ?? createConsoleLogger();
    this.sessionStore = new SessionStore({
      workspaceRoot: this.workspaceRoot,
      runtimeVersion: this.runtimeVersion,
      model: this.modelName,
      sessionDir: options.sessionDir,
    });
    this.runStore = new RunStore({
      workspaceRoot: this.workspaceRoot,
    });
    this.maxTurns = options.maxTurns ?? 12;
    this.toolConfig = options.toolConfig ?? {
      toolTimeoutMs: 60_000,
      bashTimeoutMs: 120_000,
      maxBashOutputBytes: 64 * 1024,
      readMaxBytes: 256 * 1024,
    };
    this.skillRegistry = skillRegistry;
    this.policy = policy;
  }

  static async create(options: RuntimeAgentOptions): Promise<RuntimeAgent> {
    const workspaceRoot = path.resolve(options.workspaceRoot);
    const skillRegistry = await SkillRegistry.discover({
      workspaceRoot,
      explicitSkillDirs: options.explicitSkillDirs ?? [],
      globalSkillDirs: options.globalSkillDirs ?? [],
    });
    const policy = createPolicyEngine({
      workspaceRoot,
      skillRoots: skillRegistry.getSkillRoots(),
      readOnly: options.readOnly ?? false,
      allowReadOutsideWorkspace: options.allowReadOutsideWorkspace ?? false,
      allowWriteOutsideWorkspace: options.allowWriteOutsideWorkspace ?? false,
    });
    return new RuntimeAgent(options, skillRegistry, policy);
  }

  async run(prompt: string, signal?: AbortSignal): Promise<RuntimeRunResult> {
    const conversation = await this.createConversation();
    return conversation.send(prompt, signal);
  }

  async createConversation(sessionId?: string): Promise<RuntimeConversation> {
    if (sessionId) {
      return this.loadConversation(sessionId);
    }

    const session = await this.sessionStore.createSession();
    return new RuntimeConversation(this, session.sessionId, session.path, []);
  }

  private async loadConversation(sessionId: string): Promise<RuntimeConversation> {
    const knownSessionIds = new Set((await this.sessionStore.listSessions()).map((session) => session.sessionId));
    if (!knownSessionIds.has(sessionId)) {
      throw new RuntimeError({
        code: "SESSION_NOT_FOUND",
        message: `Session not found: ${sessionId}`,
      });
    }

    const loaded = await this.sessionStore.loadSession(sessionId, { mode: "strict" });
    if (loaded.status === "corrupted") {
      throw new RuntimeError({
        code: "SESSION_CORRUPTED",
        message: `Session ${sessionId} is corrupted and cannot be resumed in strict mode`,
      });
    }
    await this.restoreActivatedSkills(loaded.entries);
    const messages = this.replayMessages(loaded.entries);
    return new RuntimeConversation(this, sessionId, loaded.path, messages, true);
  }

  private async restoreActivatedSkills(entries: SessionEntry[]): Promise<void> {
    const activatedSkills = new Set(
      entries
        .filter((entry): entry is Extract<SessionEntry, { type: "skill_activation" }> => entry.type === "skill_activation")
        .map((entry) => entry.skill),
    );

    for (const skill of activatedSkills) {
      await this.skillRegistry.activate(skill);
    }
  }

  private replayMessages(entries: SessionEntry[]): RuntimeMessage[] {
    return entries
      .flatMap((entry) => {
        if (entry.type === "message") {
          return [
            {
              role: entry.role,
              content: entry.content,
              messageId: entry.messageId,
              toolCallId: entry.toolCallId,
              toolName: entry.toolName,
              toolCalls: entry.toolCalls,
            } satisfies RuntimeMessage,
          ];
        }

        if (entry.type === "tool_result") {
          const result: ToolExecutionResult = {
            ok: entry.ok,
            content: entry.content,
            meta: entry.meta ?? entry.data,
            error: entry.error,
          };
          return [
            {
              role: "tool",
              content: formatToolMessageContent(result),
              messageId: `tool_${entry.toolCallId}`,
              toolCallId: entry.toolCallId,
              toolName: undefined,
              toolCalls: undefined,
            } satisfies RuntimeMessage,
          ];
        }

        return [];
      });
  }
}
