import path from "node:path";

import type { ModelAdapter, ModelStreamEvent } from "../model/types.js";
import { SkillRegistry } from "../skills/registry.js";
import { createDefaultToolRegistry, ToolRegistry } from "../tools/index.js";
import { FileMutationQueue } from "../tools/file-mutation-queue.js";
import type { RuntimeTool, ToolExecutionResult, ToolRuntimeConfig } from "../tools/types.js";
import { createConsoleLogger, type Logger } from "../utils/logger.js";
import { isRuntimeError, RuntimeError, toRuntimeErrorShape } from "./errors.js";
import { EventBus } from "./events.js";
import { formatToolMessageContent, runAgentLoop, type ToolMiddleware } from "./loop.js";
import { createPolicyEngine, type PolicyEngine } from "./policy.js";
import { buildActiveSkillsBlock, buildBaseSystemPrompt } from "./prompt.js";
import { RunManager } from "./run-manager.js";
import { RunStore } from "./run-store.js";
import { SessionStore } from "./session.js";
import type { AssistantMessage, RuntimeMessage, SessionEntry, ToolResultEntry } from "./types.js";

export interface RuntimeAgentOptions {
  workspaceRoot: string;
  runtimeVersion: string;
  modelName: string;
  providerName?: string;
  modelAdapter: ModelAdapter;
  baseTools?: RuntimeTool[];
  explicitSkillDirs?: string[];
  globalSkillDirs?: string[];
  disabledSkillNames?: string[];
  maxTurns?: number;
  /** 每次模型请求的最大输出 token 数；留空则用供应商默认值。长 finalize 载荷被截断时应调大。 */
  maxOutputTokens?: number;
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

export interface RunOverrides {
  extraTools?: RuntimeTool[];
  toolMiddleware?: ToolMiddleware;
  modelAdapter?: ModelAdapter;
  onModelStreamEvent?: (event: ModelStreamEvent) => void;
  /** 本次运行的思考开关（DeepSeek thinking:{type}）：透传到模型请求；留空则不发送。 */
  thinking?: { type: "enabled" | "disabled" };
}

function interruptedToolResult(): ToolExecutionResult {
  return {
    ok: false,
    content: "Tool result was not recorded before the session ended; the previous run was interrupted.",
    error: { code: "RUN_ABORTED", message: "Tool result missing from an interrupted run." },
  };
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
    private skillRegistry = agent.skillRegistry.fork(),
  ) {
    this.messages = messages;
  }

  send(
    prompt: string,
    signal: AbortSignal = new AbortController().signal,
    overrides?: RunOverrides,
  ): Promise<RuntimeRunResult> {
    const next = this.sendQueue.then(() =>
      this.agent.sessionStore.withSessionLock(
        this.sessionId,
        async () => {
          const state = await this.agent.loadConversationState(this.sessionId);
          this.messages = state.messages;
          this.skillRegistry = state.skillRegistry;
          return this.sendInternal(prompt, signal, overrides);
        },
        signal,
      ),
    );
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

  private async sendInternal(prompt: string, signal: AbortSignal, overrides?: RunOverrides): Promise<RuntimeRunResult> {
    const toolRegistry = overrides?.extraTools?.length
      ? this.agent.toolRegistry.withExtraTools(overrides.extraTools)
      : this.agent.toolRegistry;
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

    let loopResult;
    try {
      loopResult = await runAgentLoop(prompt, this.sessionId, {
        modelAdapter: overrides?.modelAdapter ?? this.agent.modelAdapter,
        toolRegistry,
        toolMiddleware: overrides?.toolMiddleware,
        onModelStreamEvent: overrides?.onModelStreamEvent,
        thinking: overrides?.thinking,
        sessionStore: this.agent.sessionStore,
        signal,
        maxTurns: this.agent.maxTurns,
        maxOutputTokens: this.agent.maxOutputTokens,
        runManager,
        createBaseSystemPrompt: () => this.getBaseSystemPrompt(),
        createActiveSkillsBlock: () => buildActiveSkillsBlock(this.skillRegistry.getActiveRecords()),
        getActiveSkillNames: () => this.skillRegistry.getActiveRecords().map((skill) => skill.meta.name),
        createToolContext: (toolCall) => ({
          workspaceRoot: this.agent.workspaceRoot,
          sessionId: this.sessionId,
          runId: runManager.runId,
          toolCallId: toolCall.id,
          signal,
          logger: this.agent.logger,
          skillRegistry: this.skillRegistry,
          policy: this.agent.policy,
          fileMutationQueue: this.agent.fileMutationQueue,
          config: this.agent.toolConfig,
          onUpdate: (partial) => {
            void runManager.recordToolProgress(toolCall, partial).catch((error: unknown) => {
              this.agent.logger.warn("Failed to persist tool progress", {
                runId: runManager.runId,
                toolCallId: toolCall.id,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          },
        }),
      }, this.messages);
    } catch (error) {
      // runAgentLoop normally finalizes its own failures. This outer guard covers
      // failures before its try/catch starts (for example the first session append).
      const runtimeError = signal.aborted
        ? new RuntimeError({ code: "RUN_ABORTED", message: "Run aborted by signal", retriable: true }).toJSON()
        : toRuntimeErrorShape(error, isRuntimeError(error) ? error.code : "INTERNAL_ERROR");
      await (runtimeError.code === "RUN_ABORTED" ? runManager.cancel(runtimeError) : runManager.fail(runtimeError)).catch(
        () => {},
      );
      throw error;
    }

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
  readonly maxOutputTokens?: number;
  readonly toolConfig: ToolRuntimeConfig;
  readonly toolRegistry: ToolRegistry;
  readonly fileMutationQueue = new FileMutationQueue();
  readonly skillRegistry: SkillRegistry;
  readonly policy: PolicyEngine;
  private readonly conversations = new Map<string, RuntimeConversation>();
  private readonly conversationLoads = new Map<string, Promise<RuntimeConversation>>();

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
    this.maxTurns = options.maxTurns ?? 30;
    this.maxOutputTokens = options.maxOutputTokens;
    this.toolRegistry = options.baseTools ? new ToolRegistry(options.baseTools) : createDefaultToolRegistry();
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
      disabledSkillNames: options.disabledSkillNames ?? [],
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

  async run(prompt: string, signal?: AbortSignal, overrides?: RunOverrides): Promise<RuntimeRunResult> {
    const conversation = await this.createConversation();
    return conversation.send(prompt, signal, overrides);
  }

  async createConversation(
    sessionId?: string,
    options: { createIfMissing?: boolean } = {},
  ): Promise<RuntimeConversation> {
    if (sessionId) {
      const cached = this.conversations.get(sessionId);
      if (cached) return cached;

      const pending = this.conversationLoads.get(sessionId) ?? this.createOrLoadConversation(sessionId, options);
      this.conversationLoads.set(sessionId, pending);
      try {
        const conversation = await pending;
        this.conversations.set(sessionId, conversation);
        return conversation;
      } finally {
        if (this.conversationLoads.get(sessionId) === pending) this.conversationLoads.delete(sessionId);
      }
    }

    const session = await this.sessionStore.createSession();
    return new RuntimeConversation(this, session.sessionId, session.path, []);
  }

  private async createOrLoadConversation(
    sessionId: string,
    options: { createIfMissing?: boolean },
  ): Promise<RuntimeConversation> {
    return this.sessionStore.withSessionLock(sessionId, async () => {
      const knownSessionIds = new Set((await this.sessionStore.listSessions()).map((session) => session.sessionId));
      if (knownSessionIds.has(sessionId)) return this.loadConversation(sessionId);

      if (!options.createIfMissing) {
        throw new RuntimeError({ code: "SESSION_NOT_FOUND", message: `Session not found: ${sessionId}` });
      }

      const created = await this.sessionStore.createSession(sessionId);
      return new RuntimeConversation(this, created.sessionId, created.path, []);
    });
  }

  private async loadConversation(sessionId: string): Promise<RuntimeConversation> {
    const knownSessionIds = new Set((await this.sessionStore.listSessions()).map((session) => session.sessionId));
    if (!knownSessionIds.has(sessionId)) {
      throw new RuntimeError({
        code: "SESSION_NOT_FOUND",
        message: `Session not found: ${sessionId}`,
      });
    }

    const state = await this.loadConversationState(sessionId);
    return new RuntimeConversation(this, sessionId, state.path, state.messages, true, state.skillRegistry);
  }

  async loadConversationState(sessionId: string): Promise<{
    path: string;
    messages: RuntimeMessage[];
    skillRegistry: SkillRegistry;
  }> {
    const loaded = await this.sessionStore.loadSession(sessionId, { mode: "strict" });
    if (loaded.status === "corrupted") {
      throw new RuntimeError({
        code: "SESSION_CORRUPTED",
        message: `Session ${sessionId} is corrupted and cannot be resumed in strict mode`,
      });
    }
    await this.persistDanglingToolCallRepairs(sessionId, loaded.entries);
    const skillRegistry = this.skillRegistry.fork();
    await this.restoreActivatedSkills(loaded.entries, skillRegistry);
    const messages = this.replayMessages(loaded.entries);
    return { path: loaded.path, messages, skillRegistry };
  }

  private async persistDanglingToolCallRepairs(sessionId: string, entries: SessionEntry[]): Promise<void> {
    const declared = new Map<string, { toolCall: NonNullable<AssistantMessage["toolCalls"]>[number]; runId?: string }>();
    const recordedCalls = new Set<string>();
    const recordedResults = new Set<string>();
    for (const entry of entries) {
      if (entry.type === "message" && entry.role === "assistant") {
        for (const toolCall of entry.toolCalls ?? []) declared.set(toolCall.id, { toolCall, runId: entry.runId });
      } else if (entry.type === "tool_call") {
        recordedCalls.add(entry.toolCallId);
      } else if (entry.type === "tool_result") {
        recordedResults.add(entry.toolCallId);
      }
    }

    for (const [toolCallId, { toolCall, runId }] of declared) {
      if (recordedResults.has(toolCallId)) continue;
      const timestamp = new Date().toISOString();
      if (!recordedCalls.has(toolCallId)) {
        const callEntry = {
          type: "tool_call" as const,
          toolCallId,
          toolName: toolCall.name,
          args: toolCall.arguments,
          timestamp,
          runId,
        };
        await this.sessionStore.appendEntry(sessionId, callEntry);
        entries.push(callEntry);
      }
      const result = interruptedToolResult();
      const resultEntry: ToolResultEntry = {
        type: "tool_result",
        toolCallId,
        ok: result.ok,
        content: result.content,
        timestamp,
        runId,
        error: result.error,
      };
      await this.sessionStore.appendEntry(sessionId, resultEntry);
      entries.push(resultEntry);
    }
  }

  private async restoreActivatedSkills(entries: SessionEntry[], skillRegistry: SkillRegistry): Promise<void> {
    const activatedSkills = new Set(
      entries
        .filter((entry): entry is Extract<SessionEntry, { type: "skill_activation" }> => entry.type === "skill_activation")
        .map((entry) => entry.skill),
    );

    for (const skill of activatedSkills) {
      await skillRegistry.activate(skill);
    }
  }

  private replayMessages(entries: SessionEntry[]): RuntimeMessage[] {
    const messages = entries.flatMap((entry) => {
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
          artifacts: entry.artifacts,
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

    return this.repairDanglingToolCalls(messages);
  }

  /**
   * Guarantee every assistant `tool_calls` entry is answered by a `tool`
   * message. A run interrupted between a tool-call request and its result (e.g.
   * the process was killed, or only some parallel tools finished) leaves the
   * session with an assistant message whose tool calls have no matching results.
   * Replaying that as-is makes the next provider request invalid ("an assistant
   * message with 'tool_calls' must be followed by tool messages for each
   * tool_call_id"), which would break resume. We synthesize an error result for
   * each unanswered tool call so the resumed conversation stays well-formed.
   */
  private repairDanglingToolCalls(messages: RuntimeMessage[]): RuntimeMessage[] {
    const repaired: RuntimeMessage[] = [];

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]!;
      repaired.push(message);

      if (message.role !== "assistant" || !message.toolCalls?.length) {
        continue;
      }

      // Consume the run of tool messages that answer this assistant turn.
      const answered = new Set<string>();
      let lookahead = index + 1;
      while (lookahead < messages.length && messages[lookahead]!.role === "tool") {
        const toolMessage = messages[lookahead]!;
        if (toolMessage.toolCallId) {
          answered.add(toolMessage.toolCallId);
        }
        repaired.push(toolMessage);
        lookahead += 1;
      }

      for (const toolCall of message.toolCalls) {
        if (answered.has(toolCall.id)) {
          continue;
        }
        const result = interruptedToolResult();
        repaired.push({
          role: "tool",
          content: formatToolMessageContent(result),
          messageId: `tool_${toolCall.id}_synthetic`,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          toolCalls: undefined,
        });
      }

      index = lookahead - 1;
    }

    return repaired;
  }
}
