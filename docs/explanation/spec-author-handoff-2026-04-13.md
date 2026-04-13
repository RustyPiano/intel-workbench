# Spec Author Handoff: Runtime v1 Status

This document is a handoff for the engineer who wrote [docs/mini-agent-runtime-spec.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/mini-agent-runtime-spec.md). It summarizes what is now implemented, what was corrected during review, what the current runtime behavior is, and what should be planned next.

## Executive summary

The v1 runtime is implemented and working as a coherent local-first agent loop.

Shipped baseline:

- runtime agent
- session store
- skill discovery and activation
- built-in tools: `read`, `write`, `edit`, `bash`, `activate_skill`
- OpenAI-compatible model adapter with configurable `provider`, `model`, `baseURL`, and `apiKey`
- CLI commands for prompt execution, `doctor`, `skills list`, `session list`, and `session show`
- docs for architecture, quickstart, config, and OpenAI-compatible setup

After implementation, a code/spec review surfaced several correctness bugs. Those have been fixed and regression-tested. The main result is that the current tree is materially closer to the spec than the initial v1 drop.

Current verification status:

- `npm run check` passes
- `npm run build` passes
- all unit and integration tests pass

Recent commits:

- `a284eb2` `feat(runtime): implement v1 agent runtime`
- `c851611` `fix(runtime): harden session replay and tool execution`
- `38c39c1` `fix(model): surface provider quota errors`

## What was corrected after review

### Session fidelity and recovery

The session layer now behaves correctly across restarts.

Fixed:

- session ids now round-trip correctly when reconstructed from JSONL filenames
- resumed conversations replay `tool_result` entries back into model context
- activated skills are restored when a session is resumed
- runtime/model failures are persisted as `error` entries in the session
- session loading now validates more event-order cases and marks malformed logs as corrupted
- existing broken sessions are no longer silently replaced by fresh sessions with the same id

Relevant code:

- [src/runtime/session.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/session.ts)
- [src/runtime/agent.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/agent.ts)
- [src/runtime/loop.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/loop.ts)

### Tool execution contract

The tool executor now enforces runtime-level guardrails instead of relying on each tool to do it ad hoc.

Fixed:

- tool argument validation runs before execution
- runtime-level tool timeout is enforced centrally
- pre-aborted runs do not start tools
- bash output streams into an artifact log while execution is in progress
- bash output is bounded in memory while still preserving the full artifact log
- per-call bash timeout requests are capped by runtime config
- bounded file reads no longer read the whole file into memory first
- bounded reads and bash tail truncation now stay on UTF-8 character boundaries

Relevant code:

- [src/tools/index.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/index.ts)
- [src/tools/bash.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/bash.ts)
- [src/tools/read.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/read.ts)

### Skill progressive disclosure

The startup discovery path now matches the spec’s progressive-disclosure requirement.

Current behavior:

- discovery reads only `SKILL.md` frontmatter
- startup builds a catalog from metadata only
- full `SKILL.md` body and resource inventory are loaded only on activation

Relevant code:

- [src/skills/discover.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/skills/discover.ts)
- [src/skills/registry.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/skills/registry.ts)

### OpenAI-compatible provider behavior

The adapter supports:

- `provider`
- `model`
- `baseURL`
- `apiKey`
- tool calling
- signal propagation into requests

It now also surfaces provider-side failure detail instead of flattening everything into a generic SDK message.

Relevant code:

- [src/model/openai-compatible.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/model/openai-compatible.ts)

## Current operational status

### Local runtime

The runtime is usable for local development and spec-driven iteration.

It can:

- create and resume sessions
- activate skills explicitly
- execute the built-in tool loop
- persist JSONL sessions and bash artifacts
- expose a useful `doctor` view

### OpenRouter / OpenAI-compatible path

The runtime can talk to OpenAI-compatible endpoints correctly, but the specific live repro against OpenRouter failed upstream with a provider quota error.

Observed command:

```bash
npm run dev -- "Summarize the workspace"
```

Observed result with:

- `MINI_AGENT_PROVIDER=openai-compatible`
- `MINI_AGENT_MODEL=google/gemma-4-31b-it:free`
- `MINI_AGENT_BASE_URL=https://openrouter.ai/api/v1`

Current surfaced error:

```text
429 Google AI Studio: Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.
```

Interpretation:

- this is not currently a malformed request bug in the runtime
- the request reaches OpenRouter
- OpenRouter forwards to an upstream provider route
- the upstream route reports quota/billing exhaustion

That means adapter correctness improved, but end-to-end success still depends on a provider/model pair that is actually available to the configured account.

## What is in good shape now

The following areas look solid enough for the next round of feature planning:

1. Session persistence as a JSONL core
2. Resume and replay behavior
3. Skill catalog vs activation split
4. Built-in tool baseline and runtime guardrails
5. Config plumbing for OpenAI-compatible providers
6. Test coverage around the major review regressions

## What still looks like planning work, not emergency bug work

These are not blockers to calling the current tree a working v1, but they are the obvious next places to invest engineering time.

### 1. Clarify the remaining spec boundary for event-order validation

The session loader now checks more ordering cases than the original implementation, but the spec language is still broad: "事件顺序是否合法".

Recommendation:

- define the legal session grammar explicitly in the spec
- list valid transitions between `message`, `tool_call`, `tool_result`, `skill_activation`, and `error`
- state whether partially written tails should be loadable in a degraded mode

That will turn future review from interpretation into conformance.

### 2. Decide how far v1 should go on streaming model output

The model adapter interface includes `stream?`, and the spec says adapters should support streaming, but the runtime loop currently operates in a request/response model with streamed tool updates only.

Recommendation:

- decide whether assistant token streaming is in-scope for the next increment
- if yes, define the event bus contract for streamed assistant text and partial tool-call assembly

### 3. Decide whether provider-specific fallback behavior belongs in the runtime

Right now the runtime reports upstream provider failures accurately, which is the correct baseline. The next product decision is whether it should do more than that.

Possible next steps:

- retry policy for transient provider failures
- optional model fallback list
- provider-specific diagnostics in `doctor`
- clearer CLI guidance when a configured model is unsupported or quota-exhausted

### 4. Expand documentation from "enough to use" to "enough to extend"

The runtime now has user-facing docs, but the implementation has moved faster than the docs in some areas.

Most useful additions:

- a maintainer-facing explanation of session invariants
- a reference page for session entry formats and corruption behavior
- a how-to for adding a new model adapter
- a how-to for writing and testing a skill

### 5. Decide whether the spec should explicitly separate MVP from post-MVP hardening

The last round of review mostly found invariant and recovery issues rather than missing top-level features. That is a sign that the project is entering a hardening phase.

Recommendation:

- split the remaining work into:
  - MVP complete
  - correctness hardening
  - UX / operator ergonomics
  - future capability work

That will make planning less ambiguous.

## Suggested next development steps

If planning starts from the current tree, this is the order I would use.

1. Lock down the session consistency grammar in the spec and add any missing corruption/recovery tests.
2. Improve operator ergonomics for model/provider failures in the CLI and `doctor`.
3. Add maintainer-facing reference docs for session format, tool contracts, and adapter expectations.
4. Decide whether assistant streaming is part of the next milestone.
5. Add one more real-provider smoke path using a known-working OpenAI-compatible model/account combination.

## Bottom line

The runtime is no longer in the "spec implemented, but shaky under review" phase.

It is now in a better place:

- core v1 runtime exists
- the major review findings were fixed
- the provider adapter reports real upstream failures accurately
- the remaining work is mostly spec tightening, operator ergonomics, and next-scope decisions

That is a reasonable point for the spec author to treat the project as a working v1 baseline and plan the next increment deliberately instead of continuing ad hoc bug triage.
