import path from "node:path";

import type { ModelAdapter } from "../model/types.js";
import { SkillRegistry } from "../skills/registry.js";
import { createDefaultToolRegistry } from "../tools/index.js";
import { FileMutationQueue } from "../tools/file-mutation-queue.js";
import { createConsoleLogger, type Logger } from "../utils/logger.js";
import { EventBus } from "./events.js";
import { runAgentLoop } from "./loop.js";
import type { RuntimeConfig } from "./config.js";
import { createPolicyEngine } from "./policy.js";
import { buildSystemPrompt } from "./prompt.js";
import { SessionStore } from "./session.js";
import type { AssistantMessage, RuntimeMessage, SessionEntry } from "./types.js";

export interface RuntimeAgentOptions {
  workspaceRoot: string;
  runtimeVersion: string;
  modelName: string;
  modelAdapter: ModelAdapter;
  explicitSkillDirs?: string[];
  globalSkillDirs?: string[];
  maxTurns?: number;
  readOnly?: boolean;
  allowReadOutsideWorkspace?: boolean;
  allowWriteOutsideWorkspace?: boolean;
  sessionDir?: string;
  toolConfig?: Pick<RuntimeConfig, "toolTimeoutMs" | "bashTimeoutMs" | "maxBashOutputBytes" | "readMaxBytes">;
  logger?: Logger;
}

export interface RuntimeRunResult {
  sessionId: string;
  sessionPath: string;
  finalMessage: AssistantMessage;
}

export class RuntimeConversation {
  private messages: RuntimeMessage[];

  constructor(
    private readonly agent: RuntimeAgent,
    readonly sessionId: string,
    readonly sessionPath: string,
    messages: RuntimeMessage[] = [],
  ) {
    this.messages = messages;
  }

  async send(prompt: string, signal: AbortSignal = new AbortController().signal): Promise<RuntimeRunResult> {
    const loopResult = await runAgentLoop(prompt, this.sessionId, {
      modelAdapter: this.agent.modelAdapter,
      toolRegistry: this.agent.toolRegistry,
      sessionStore: this.agent.sessionStore,
      eventBus: this.agent.eventBus,
      signal,
      maxTurns: this.agent.maxTurns,
      createSystemPrompt: () =>
        buildSystemPrompt({
          workspaceRoot: this.agent.workspaceRoot,
          availableSkills: this.agent.skillRegistry.getCatalog(),
          activeSkills: this.agent.skillRegistry.getActiveRecords(),
        }),
      createToolContext: (toolCall) => ({
        workspaceRoot: this.agent.workspaceRoot,
        sessionId: this.sessionId,
        toolCallId: toolCall.id,
        signal,
        logger: this.agent.logger,
        skillRegistry: this.agent.skillRegistry,
        policy: this.agent.policy,
        fileMutationQueue: this.agent.fileMutationQueue,
        config: this.agent.toolConfig,
        onUpdate: (partial) =>
          this.agent.eventBus.emit({
            type: "tool_execution_update",
            toolCallId: toolCall.id,
            partial,
          }),
      }),
    }, this.messages);

    this.messages = loopResult.messages;

    return {
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
  readonly modelAdapter: ModelAdapter;
  readonly logger: Logger;
  readonly eventBus = new EventBus();
  readonly sessionStore: SessionStore;

  private readonly explicitSkillDirs: string[];
  private readonly globalSkillDirs: string[];
  readonly maxTurns: number;
  private readonly readOnly: boolean;
  private readonly allowReadOutsideWorkspace: boolean;
  private readonly allowWriteOutsideWorkspace: boolean;
  private readonly sessionDir?: string;
  readonly toolConfig: Pick<RuntimeConfig, "toolTimeoutMs" | "bashTimeoutMs" | "maxBashOutputBytes" | "readMaxBytes">;
  private initialized = false;
  skillRegistry!: SkillRegistry;
  policy = createPolicyEngine({ workspaceRoot: ".", readOnly: false });
  readonly toolRegistry = createDefaultToolRegistry();
  readonly fileMutationQueue = new FileMutationQueue();

  constructor(options: RuntimeAgentOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.runtimeVersion = options.runtimeVersion;
    this.modelName = options.modelName;
    this.modelAdapter = options.modelAdapter;
    this.logger = options.logger ?? createConsoleLogger();
    this.sessionStore = new SessionStore({
      workspaceRoot: this.workspaceRoot,
      runtimeVersion: this.runtimeVersion,
      model: this.modelName,
      sessionDir: options.sessionDir,
    });
    this.explicitSkillDirs = options.explicitSkillDirs ?? [];
    this.globalSkillDirs = options.globalSkillDirs ?? [];
    this.maxTurns = options.maxTurns ?? 12;
    this.readOnly = options.readOnly ?? false;
    this.allowReadOutsideWorkspace = options.allowReadOutsideWorkspace ?? false;
    this.allowWriteOutsideWorkspace = options.allowWriteOutsideWorkspace ?? false;
    this.sessionDir = options.sessionDir;
    this.toolConfig = options.toolConfig ?? {
      toolTimeoutMs: 60_000,
      bashTimeoutMs: 120_000,
      maxBashOutputBytes: 64 * 1024,
      readMaxBytes: 256 * 1024,
    };
  }

  async run(prompt: string, signal?: AbortSignal): Promise<RuntimeRunResult> {
    const conversation = await this.createConversation();
    try {
      return await conversation.send(prompt, signal);
    } finally {
      this.eventBus.emit({ type: "agent_end", sessionId: conversation.sessionId });
    }
  }

  async createConversation(sessionId?: string): Promise<RuntimeConversation> {
    await this.initialize();

    const existing = sessionId ? await this.tryLoadConversation(sessionId) : null;
    if (existing) {
      this.eventBus.emit({ type: "agent_start", sessionId: existing.sessionId });
      return existing;
    }

    const session = await this.sessionStore.createSession(sessionId);
    this.eventBus.emit({ type: "agent_start", sessionId: session.sessionId });
    return new RuntimeConversation(this, session.sessionId, session.path, []);
  }

  private async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.skillRegistry = await SkillRegistry.discover({
      workspaceRoot: this.workspaceRoot,
      explicitSkillDirs: this.explicitSkillDirs,
      globalSkillDirs: this.globalSkillDirs,
    });
    this.policy = createPolicyEngine({
      workspaceRoot: this.workspaceRoot,
      skillRoots: this.skillRegistry.getSkillRoots(),
      readOnly: this.readOnly,
      allowReadOutsideWorkspace: this.allowReadOutsideWorkspace,
      allowWriteOutsideWorkspace: this.allowWriteOutsideWorkspace,
    });
    this.initialized = true;
  }

  private async tryLoadConversation(sessionId: string): Promise<RuntimeConversation | null> {
    const knownSessionIds = new Set((await this.sessionStore.listSessions()).map((session) => session.sessionId));
    if (!knownSessionIds.has(sessionId)) {
      return null;
    }

    const loaded = await this.sessionStore.loadSession(sessionId, { mode: "strict" });
    if (loaded.status === "corrupted") {
      throw new Error(`Session ${sessionId} is corrupted and cannot be resumed in strict mode`);
    }
    await this.restoreActivatedSkills(loaded.entries);
    const messages = this.replayMessages(loaded.entries);
    return new RuntimeConversation(this, sessionId, loaded.path, messages);
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
          return [
            {
              role: "tool",
              content: JSON.stringify({
                ok: entry.ok,
                content: entry.content,
                meta: entry.meta ?? entry.data,
                error: entry.error,
              }),
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
