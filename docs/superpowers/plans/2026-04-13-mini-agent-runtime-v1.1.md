# Mini Agent Runtime v1.1 Implementation Plan

> Status: Completed on 2026-04-13. This file is preserved as the historical execution plan for the released v1.1 work. See [docs/releases/v1.1.0.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/releases/v1.1.0.md) and [docs/explanation/spec-author-handoff-v1.1-completion-2026-04-13.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/explanation/spec-author-handoff-v1.1-completion-2026-04-13.md) for the finalized outcome.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `v1.1` hardening scope from [docs/mini-agent-runtime-v1.1-spec.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/mini-agent-runtime-v1.1-spec.md) without expanding the runtime beyond its current architecture.

**Architecture:** Keep the current v1 runtime structure intact and treat `v1.1` as a delta pass. The work should tighten contracts in the existing session/tool/CLI layers, then add maintainer-facing docs and a first-skill readiness package on top of the current baseline.

**Tech Stack:** TypeScript, Node.js, Vitest, JSONL session storage, OpenAI-compatible model adapter, Markdown docs

---

## File Map

### Runtime / session

- [src/runtime/types.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/types.ts): session entry shapes, session status types
- [src/runtime/session.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/session.ts): loader, corruption detection, recover mode
- [src/runtime/agent.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/agent.ts): resume rules
- [src/runtime/loop.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/loop.ts): session error semantics

### Tools

- [src/tools/types.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/types.ts): normalized tool result envelope
- [src/tools/index.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/index.ts): runtime-level validation, timeout, abort semantics
- [src/tools/read.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/read.ts): bounded read contract
- [src/tools/write.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/write.ts): artifact/meta normalization
- [src/tools/edit.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/edit.ts): edit normalization and diagnostics
- [src/tools/bash.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/bash.ts): artifact/log/tail contract
- [src/tools/activate-skill.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/activate-skill.ts): activation envelope normalization

### CLI / config / provider diagnostics

- [src/cli/main.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/cli/main.ts): `doctor`, `session show --recover`, clearer CLI errors
- [src/runtime/config.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/config.ts): smoke-path config surface
- [src/model/openai-compatible.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/model/openai-compatible.ts): provider error categorization

### Docs

- [docs/mini-agent-v1.1-entry-gate.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/mini-agent-v1.1-entry-gate.md): gate status and scope boundary
- [docs/mini-agent-runtime-v1.1-spec.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/mini-agent-runtime-v1.1-spec.md): delta spec
- [docs/reference/session-format.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/reference/session-format.md): new reference
- [docs/reference/tool-contracts.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/reference/tool-contracts.md): new reference
- [docs/reference/model-adapter.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/reference/model-adapter.md): new reference
- [docs/how-to/write-a-skill.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/how-to/write-a-skill.md): new maintainer how-to

### Skill readiness

- [fixtures/intel-bulletin/source-note.md](/Users/wangsiyuan/编程/小项目/mini-agent/fixtures/intel-bulletin/source-note.md): sample input
- [fixtures/intel-bulletin/expected-report.md](/Users/wangsiyuan/编程/小项目/mini-agent/fixtures/intel-bulletin/expected-report.md): acceptance output
- [tests/integration/intel-bulletin-readiness.test.ts](/Users/wangsiyuan/编程/小项目/mini-agent/tests/integration/intel-bulletin-readiness.test.ts): readiness verification

---

### Task 1: Session Grammar And Recover Mode

**Files:**
- Modify: [src/runtime/types.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/types.ts)
- Modify: [src/runtime/session.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/session.ts)
- Modify: [src/runtime/agent.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/agent.ts)
- Modify: [src/cli/main.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/cli/main.ts)
- Test: [tests/unit/session.test.ts](/Users/wangsiyuan/编程/小项目/mini-agent/tests/unit/session.test.ts)
- Test: [tests/integration/runtime-loop.test.ts](/Users/wangsiyuan/编程/小项目/mini-agent/tests/integration/runtime-loop.test.ts)

- [ ] **Step 1: Write failing tests for loader status and recover mode**

```ts
expect(loaded.status).toBe("degraded");
expect(recovered.entries.at(-1)?.type).toBe("tool_result");
await expect(agent.createConversation(corruptedSessionId)).rejects.toThrow();
```

- [ ] **Step 2: Run the targeted session tests**

Run:

```bash
npm run test:run -- tests/unit/session.test.ts tests/integration/runtime-loop.test.ts
```

Expected: failures for missing `status`, missing recover mode, and missing `session show --recover` handling.

- [ ] **Step 3: Add session health types and loader mode**

Define the new session loader surface in [src/runtime/types.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/types.ts) and [src/runtime/session.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/session.ts):

```ts
export type SessionHealth = "valid" | "degraded" | "corrupted";
export type SessionLoadMode = "strict" | "recover";
```

Update `LoadedSession` to carry:

- `status`
- `repairNotes`
- `recoveredFromPath?`

Implement longest-valid-prefix recovery for `loadSession(id, { mode: "recover" })`.

- [ ] **Step 4: Thread strict vs recover behavior into agent and CLI**

Add `session show --recover` parsing in [src/cli/main.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/cli/main.ts), and keep resume on strict mode in [src/runtime/agent.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/agent.ts).

```ts
const session = await store.loadSession(command[2], {
  mode: command.includes("--recover") ? "recover" : "strict",
});
```

- [ ] **Step 5: Re-run targeted tests and full verification**

Run:

```bash
npm run test:run -- tests/unit/session.test.ts tests/integration/runtime-loop.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/types.ts src/runtime/session.ts src/runtime/agent.ts src/cli/main.ts tests/unit/session.test.ts tests/integration/runtime-loop.test.ts
git commit -m "feat(session): add health states and recover mode"
```

---

### Task 2: Normalize The Tool Execution Contract

**Files:**
- Modify: [src/tools/types.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/types.ts)
- Modify: [src/tools/index.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/index.ts)
- Modify: [src/tools/read.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/read.ts)
- Modify: [src/tools/write.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/write.ts)
- Modify: [src/tools/edit.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/edit.ts)
- Modify: [src/tools/bash.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/bash.ts)
- Modify: [src/tools/activate-skill.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/activate-skill.ts)
- Modify: [src/runtime/loop.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/loop.ts)
- Test: [tests/unit/tool-registry.test.ts](/Users/wangsiyuan/编程/小项目/mini-agent/tests/unit/tool-registry.test.ts)
- Test: [tests/unit/read.test.ts](/Users/wangsiyuan/编程/小项目/mini-agent/tests/unit/read.test.ts)
- Test: [tests/unit/bash.test.ts](/Users/wangsiyuan/编程/小项目/mini-agent/tests/unit/bash.test.ts)
- Test: [tests/unit/write.test.ts](/Users/wangsiyuan/编程/小项目/mini-agent/tests/unit/write.test.ts)
- Test: [tests/unit/edit.test.ts](/Users/wangsiyuan/编程/小项目/mini-agent/tests/unit/edit.test.ts)

- [ ] **Step 1: Write failing tests for the v1.1 envelope shape**

Add assertions like:

```ts
expect(result.artifacts?.[0]).toMatchObject({
  type: "log",
  path: expect.any(String),
});
expect(result.meta).toBeDefined();
```

- [ ] **Step 2: Run the tool-focused suite**

Run:

```bash
npm run test:run -- tests/unit/tool-registry.test.ts tests/unit/read.test.ts tests/unit/write.test.ts tests/unit/edit.test.ts tests/unit/bash.test.ts
```

Expected: failures because the current envelope still uses `kind`/`data` rather than the v1.1 draft shape.

- [ ] **Step 3: Introduce the normalized result type**

In [src/tools/types.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/types.ts), move the contract toward the v1.1 draft:

```ts
export interface ToolArtifact {
  type: "log" | "file" | "json";
  path: string;
  description?: string;
}

export interface ToolExecutionResult<T = unknown> {
  ok: boolean;
  content: string;
  meta?: T;
  error?: RuntimeErrorShape;
  artifacts?: ToolArtifact[];
}
```

- [ ] **Step 4: Update all built-in tools and loop serialization**

Map previous `data` fields into `meta`, convert artifact `kind` to `type`, and keep `content` as the model-facing summary string. Update [src/runtime/loop.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/loop.ts) so session replay persists the normalized envelope consistently.

- [ ] **Step 5: Re-run the targeted tests and full verification**

Run:

```bash
npm run test:run -- tests/unit/tool-registry.test.ts tests/unit/read.test.ts tests/unit/write.test.ts tests/unit/edit.test.ts tests/unit/bash.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/types.ts src/tools/index.ts src/tools/read.ts src/tools/write.ts src/tools/edit.ts src/tools/bash.ts src/tools/activate-skill.ts src/runtime/loop.ts tests/unit/tool-registry.test.ts tests/unit/read.test.ts tests/unit/write.test.ts tests/unit/edit.test.ts tests/unit/bash.test.ts
git commit -m "feat(tools): normalize v1.1 tool contract"
```

---

### Task 3: Upgrade CLI And Doctor Diagnostics

**Files:**
- Modify: [src/cli/main.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/cli/main.ts)
- Modify: [src/runtime/config.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/config.ts)
- Modify: [src/model/openai-compatible.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/model/openai-compatible.ts)
- Create: [tests/unit/cli-doctor.test.ts](/Users/wangsiyuan/编程/小项目/mini-agent/tests/unit/cli-doctor.test.ts)

- [ ] **Step 1: Write failing tests for grouped doctor output**

Add assertions like:

```ts
expect(output).toContain("runtime_basics");
expect(output).toContain("session_health");
expect(output).toContain("smoke_path");
```

- [ ] **Step 2: Run the new doctor-focused test**

Run:

```bash
npm run test:run -- tests/unit/cli-doctor.test.ts
```

Expected: FAIL because the current `doctor` output is still flat.

- [ ] **Step 3: Add smoke-path config surface and grouped output**

Extend [src/runtime/config.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/config.ts) with optional smoke settings:

```ts
smokeProvider?: string;
smokeModel?: string;
smokeBaseURL?: string;
```

Then group `doctor` output in [src/cli/main.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/cli/main.ts) by:

- runtime basics
- model/provider config
- skill discovery
- session health
- smoke path

- [ ] **Step 4: Preserve clear provider error categories**

Keep the recent provider-detail surfacing in [src/model/openai-compatible.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/model/openai-compatible.ts), but add category mapping for quota/auth/network/malformed-response paths.

```ts
const category = inferProviderErrorCategory(error);
```

- [ ] **Step 5: Re-run tests and full verification**

Run:

```bash
npm run test:run -- tests/unit/cli-doctor.test.ts tests/unit/openai-compatible.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/main.ts src/runtime/config.ts src/model/openai-compatible.ts tests/unit/cli-doctor.test.ts tests/unit/openai-compatible.test.ts
git commit -m "feat(cli): improve doctor and provider diagnostics"
```

---

### Task 4: Publish The Maintainer Reference Set

**Files:**
- Create: [docs/reference/session-format.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/reference/session-format.md)
- Create: [docs/reference/tool-contracts.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/reference/tool-contracts.md)
- Create: [docs/reference/model-adapter.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/reference/model-adapter.md)
- Create: [docs/how-to/write-a-skill.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/how-to/write-a-skill.md)
- Modify: [docs/mini-agent-runtime-v1.1-spec.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/mini-agent-runtime-v1.1-spec.md)

- [ ] **Step 1: Draft the reference stubs from the v1.1 spec**

Create the four new docs with the minimum headings needed to stop the spec from carrying all maintainer detail itself.

```md
# Session Format
## Entry Types
## Loader Modes
## Health States
## Recovery Rules
```

- [ ] **Step 2: Link the spec to the reference docs**

Trim repeated detail in [docs/mini-agent-runtime-v1.1-spec.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/mini-agent-runtime-v1.1-spec.md) where appropriate and link out to the new references.

- [ ] **Step 3: Verify docs for consistency**

Run:

```bash
rg -n "TODO|TBD" docs/reference docs/how-to docs/mini-agent-runtime-v1.1-spec.md
```

Expected: no placeholders.

- [ ] **Step 4: Commit**

```bash
git add docs/reference/session-format.md docs/reference/tool-contracts.md docs/reference/model-adapter.md docs/how-to/write-a-skill.md docs/mini-agent-runtime-v1.1-spec.md
git commit -m "docs: add v1.1 maintainer references"
```

---

### Task 5: Land Intel-Bulletin Readiness Fixtures

**Files:**
- Create: [fixtures/intel-bulletin/source-note.md](/Users/wangsiyuan/编程/小项目/mini-agent/fixtures/intel-bulletin/source-note.md)
- Create: [fixtures/intel-bulletin/expected-report.md](/Users/wangsiyuan/编程/小项目/mini-agent/fixtures/intel-bulletin/expected-report.md)
- Create: [tests/integration/intel-bulletin-readiness.test.ts](/Users/wangsiyuan/编程/小项目/mini-agent/tests/integration/intel-bulletin-readiness.test.ts)
- Modify: [docs/mini-agent-v1.1-entry-gate.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/mini-agent-v1.1-entry-gate.md)
- Modify: [docs/how-to/write-a-skill.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/how-to/write-a-skill.md)

- [ ] **Step 1: Create sample input and expected output fixtures**

Add a tiny but stable example:

```md
# Source Notes
- Team approved the launch plan.
- Risk: vendor turnaround is still unknown.
```

and:

```md
# Bulletin
## Decision
Team approved the launch plan.
## Risk
Vendor turnaround is still unknown.
```

- [ ] **Step 2: Write the readiness integration test**

Use the current runtime primitives to assert:

```ts
expect(report).toContain("Decision");
expect(session.entries.some((entry) => entry.type === "skill_activation")).toBe(true);
```

- [ ] **Step 3: Re-run the readiness test and full verification**

Run:

```bash
npm run test:run -- tests/integration/intel-bulletin-readiness.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 4: Update the gate doc to mark Gate E closed**

Change [docs/mini-agent-v1.1-entry-gate.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/mini-agent-v1.1-entry-gate.md) once the fixtures and acceptance path exist.

- [ ] **Step 5: Commit**

```bash
git add fixtures/intel-bulletin/source-note.md fixtures/intel-bulletin/expected-report.md tests/integration/intel-bulletin-readiness.test.ts docs/mini-agent-v1.1-entry-gate.md docs/how-to/write-a-skill.md
git commit -m "feat(skill): add intel-bulletin readiness fixtures"
```

---

### Task 6: Close The Remaining Entry Gate Items

**Files:**
- Modify: [docs/mini-agent-v1.1-entry-gate.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/mini-agent-v1.1-entry-gate.md)
- Modify: [docs/explanation/spec-author-handoff-2026-04-13.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/explanation/spec-author-handoff-2026-04-13.md)
- Modify: [docs/reference/cli-and-config.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/reference/cli-and-config.md)

- [ ] **Step 1: Update the gate doc from assessment to closure**

When Tasks 1-5 are complete, rewrite the status lines in [docs/mini-agent-v1.1-entry-gate.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/mini-agent-v1.1-entry-gate.md) so Gate B/D/E move from partial/open to closed.

- [ ] **Step 2: Update the handoff summary**

Add a short section to [docs/explanation/spec-author-handoff-2026-04-13.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/explanation/spec-author-handoff-2026-04-13.md) noting that v1.1 gate prerequisites are now met.

- [ ] **Step 3: Verify the docs tree**

Run:

```bash
find docs -maxdepth 3 -type f | sort
git diff -- docs
```

Expected: all planned docs exist and the gate decision is internally consistent.

- [ ] **Step 4: Commit**

```bash
git add docs/mini-agent-v1.1-entry-gate.md docs/explanation/spec-author-handoff-2026-04-13.md docs/reference/cli-and-config.md
git commit -m "docs: close the v1.1 entry gate"
```

---

## Self-Review

### Spec coverage

Covered:

- Session Grammar & Recovery
- Tool Execution Contract
- CLI / Doctor Operator Ergonomics
- Maintainer Documentation
- First-skill readiness

Not covered as implementation work in this plan:

- assistant token streaming
- provider fallback / retry chains
- session branching
- subagents

These are intentionally deferred by the v1.1 spec.

### Placeholder scan

This plan avoids `TODO`, `TBD`, and vague "handle appropriately" steps. The remaining choices are explicit project decisions, not missing placeholders.

### Type consistency

The plan consistently uses:

- `SessionHealth = "valid" | "degraded" | "corrupted"`
- `SessionLoadMode = "strict" | "recover"`
- `meta` for normalized tool metadata
- `artifacts[].type` for artifact class

If those names change during implementation, the plan and spec should be updated together.
