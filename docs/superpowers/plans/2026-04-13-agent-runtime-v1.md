# Agent Runtime v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first complete `mini-agent` runtime that satisfies the spec's MVP, acceptance criteria, and required tests.

**Architecture:** Use a small Node/TypeScript CLI that wires a deterministic runtime loop to a replaceable model adapter, a tool registry, a skill registry, a JSONL session store, and a policy layer. Keep the runtime file-first and event-driven so the core stays inspectable and every side effect is recorded.

**Tech Stack:** Node.js 20+, TypeScript 5.x, Vitest, OpenAI SDK, gray-matter, fast-glob, zod

---

### Task 1: Project Skeleton And Shared Contracts

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/runtime/types.ts`
- Create: `src/runtime/errors.ts`
- Create: `src/runtime/events.ts`
- Create: `src/utils/ids.ts`
- Create: `src/utils/logger.ts`

- [ ] Write shared runtime and tool tests first.
- [ ] Add the minimal build, typecheck, and test setup.
- [ ] Add runtime base types, error shapes, and an event bus.
- [ ] Run `npm run typecheck` and `npm run test:run`.

### Task 2: Policy And Session Persistence

**Files:**
- Create: `src/runtime/policy.ts`
- Create: `src/runtime/session.ts`
- Create: `src/utils/jsonl.ts`
- Create: `tests/unit/policy.test.ts`
- Create: `tests/unit/session.test.ts`

- [ ] Write failing tests for path guards, read/write restrictions, session header creation, and corrupted-session recovery.
- [ ] Implement policy resolution and JSONL session storage.
- [ ] Re-run the targeted tests until green.

### Task 3: Skill Parsing, Discovery, And Activation

**Files:**
- Create: `src/skills/types.ts`
- Create: `src/skills/parse-skill.ts`
- Create: `src/skills/discover.ts`
- Create: `src/skills/catalog.ts`
- Create: `src/skills/registry.ts`
- Create: `src/tools/activate-skill.ts`
- Create: `tests/unit/parse-skill.test.ts`
- Create: `tests/unit/discover.test.ts`

- [ ] Write failing tests for frontmatter parsing, metadata validation, discovery order, and conflict override handling.
- [ ] Implement parsing, discovery, catalog rendering, registry caching, and activation output.
- [ ] Re-run unit tests for green coverage.

### Task 4: Core Tools

**Files:**
- Create: `src/tools/types.ts`
- Create: `src/tools/index.ts`
- Create: `src/tools/read.ts`
- Create: `src/tools/write.ts`
- Create: `src/tools/edit.ts`
- Create: `src/tools/bash.ts`
- Create: `src/tools/file-mutation-queue.ts`
- Create: `src/tools/utils/paths.ts`
- Create: `src/tools/utils/text-normalize.ts`
- Create: `tests/unit/read.test.ts`
- Create: `tests/unit/write.test.ts`
- Create: `tests/unit/edit.test.ts`
- Create: `tests/unit/bash.test.ts`

- [ ] Write failing tests for read limits, atomic write behavior, edit matching and ambiguity, bash timeouts, and artifact logging.
- [ ] Implement tools and the write queue.
- [ ] Re-run the tool tests until green.

### Task 5: Model Adapters, Prompt Assembly, And Runtime Loop

**Files:**
- Create: `src/model/types.ts`
- Create: `src/model/mock.ts`
- Create: `src/model/openai.ts`
- Create: `src/runtime/prompt.ts`
- Create: `src/runtime/loop.ts`
- Create: `src/runtime/agent.ts`
- Create: `tests/integration/runtime-loop.test.ts`

- [ ] Write failing integration tests for a scripted model driving `read -> edit -> write`, skill activation, bash timeout, and session logging.
- [ ] Implement the prompt builder, mock adapter, OpenAI adapter, and runtime loop.
- [ ] Re-run the integration tests until green.

### Task 6: CLI And Example Skill

**Files:**
- Create: `src/cli/main.ts`
- Create: `src/cli/repl.ts`
- Create: `.agents/skills/intel-bulletin/SKILL.md`
- Create: `.agents/skills/intel-bulletin/scripts/render_report.py`
- Create: `.agents/skills/intel-bulletin/references/writing-guide.md`
- Modify: `README.md`

- [ ] Write failing CLI smoke tests where useful.
- [ ] Implement single-shot mode, REPL mode, skill listing, session listing/showing, and doctor output.
- [ ] Add the example business skill and document the runtime.

### Task 7: Verification

**Files:**
- Modify as needed: repo files touched above

- [ ] Run `npm run typecheck`.
- [ ] Run `npm run test:run`.
- [ ] Run `npm run build`.
- [ ] Run a CLI smoke command against the built runtime.
- [ ] Review for spec gaps and close any missing acceptance criteria.
