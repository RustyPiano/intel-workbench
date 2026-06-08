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
  RuntimeAgentOptions,
  RuntimeRunResult,
} from "./runtime/agent.js";

export { RUNTIME_VERSION } from "./runtime/version.js";

export { createModelAdapter } from "./model/factory.js";
export type { ModelFactoryOptions } from "./model/factory.js";
export type {
  ModelAdapter,
  GenerateInput,
  GenerateResult,
  ToolSpec,
} from "./model/types.js";
