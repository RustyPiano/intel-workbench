/**
 * Public package entrypoint for `mini-agent` (the `core` runtime).
 *
 * This barrel re-exports the stable surface that downstream workspace
 * packages (notably `@intel-workbench/server`) consume so they can
 * `import { RuntimeAgent } from "mini-agent"` without reaching into deep
 * relative paths. Keep this additive: the published package contents and the
 * existing CLI bin entry are unchanged.
 */

export { RuntimeAgent, RuntimeConversation } from "./runtime/agent.js";
export type {
  RunOverrides,
  RuntimeAgentOptions,
  RuntimeRunResult,
} from "./runtime/agent.js";
export type { ToolMiddleware } from "./runtime/loop.js";
export type { ToolCall } from "./runtime/types.js";

export { RUNTIME_VERSION } from "./runtime/version.js";

// Per-path serialization primitive; reused by the workbench server to make
// per-case manifest mutations single-writer (二期 P2.3a 串行化阻塞项).
export { FileMutationQueue } from "./tools/file-mutation-queue.js";

export { createModelAdapter } from "./model/factory.js";
export type { ModelFactoryOptions } from "./model/factory.js";
export type {
  ModelAdapter,
  GenerateInput,
  GenerateResult,
  ModelStreamEvent,
  ToolSpec,
} from "./model/types.js";
export type {
  RuntimeTool,
  ToolArtifact,
  ToolContext,
  ToolExecutionResult,
} from "./tools/types.js";
