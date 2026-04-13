# Spec Author Handoff: v1.2 Observable Runtime

This document is the handoff for the engineer who wrote [docs/mini-agent-runtime-v1.2-spec.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/mini-agent-runtime-v1.2-spec.md).

It is meant to answer three practical questions:

1. What has actually landed relative to the `v1.2` spec?
2. What problems were found during implementation and review?
3. What should the spec author decide next before planning another iteration?

## Executive summary

The `v1.2` observable-runtime slice is now implemented as a coherent runtime feature set.

Delivered in substance:

- per-run trace persistence under `.mini-agent/runs/<run-id>/`
- structured runtime events for planning, model calls, tools, skills, artifacts, and terminal run state
- live CLI trace rendering during execution
- offline trace inspection through `run list`, `run show`, `session show --trace`, and `doctor --last-run/--run`
- redaction-aware summaries and operator-facing diagnostics
- append-only trace storage with degraded/recover handling

After the main implementation landed, the code went through a full subagent-driven review cycle covering both spec alignment and code quality. Multiple issues were found. Those issues were fixed, re-reviewed, and regression-tested.

One additional post-review regression was then reported from live REPL usage: duplicate timeline output. That bug was also fixed and committed.

Current verification status after the latest fix:

- `npm run check` passes
- `npm run build` passes
- all current tests pass

Current test/build state:

- 21 test files pass
- 69 tests pass

Relevant commits:

- `34aa3e1` `feat(runtime): add observable run tracing`
- `019bc29` `fix(cli): avoid duplicate repl timeline output`

Bottom line:

`v1.2` should now be treated as implemented and review-hardened, not as an unfinished draft. The remaining work is mainly product-direction planning, contract clarification, and deciding what should count as `v1.3`.

## 1. What v1.2 was supposed to do

Per the current spec, `v1.2` was not a general feature expansion. It was a targeted observability iteration for the local agent runtime.

The intended delta was:

1. Introduce a first-class run concept beside the existing session log
2. Record a structured timeline for each run
3. Preserve enough detail for operator debugging without turning the runtime into a full tracing platform
4. Expose that trace through the CLI in both live and offline forms
5. Keep the design local-first and compatible with the existing JSONL/session baseline

This means `v1.2` should be judged on whether a maintainer can now answer practical questions such as:

- What did the agent do in this run?
- Which model/tool/skill step failed?
- Was the run cancelled, failed, or completed?
- Where are the relevant logs and artifacts?
- Can I inspect the last run after the fact without replaying the whole session manually?

On those questions, the current tree now has concrete answers.

## 2. What was delivered

### 2.1 Run trace schema and event model

Delivered:

- a normalized runtime trace event layer in [src/runtime/trace.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/trace.ts)
- event types for:
  - `run_started`
  - `planning_summary`
  - `model_request_started`
  - `model_response_received`
  - `tool_started`
  - `tool_progress`
  - `tool_completed`
  - `skill_activated`
  - `artifact_created`
  - `assistant_completed`
  - `run_completed`
  - `run_failed`
  - `run_cancelled`
- trace-oriented error classification and redacted summary helpers

Practical result:

- the runtime now records explicit operational state rather than requiring maintainers to infer run behavior from session messages alone
- terminal state is distinguishable in a machine-readable way
- tool/model/skill activity is visible as a run timeline rather than hidden inside mixed assistant/session records

### 2.2 Run store and persistence layout

Delivered in [src/runtime/run-store.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/run-store.ts):

- per-run storage rooted at `.mini-agent/runs/<run-id>/`
- `meta.json` for run-level summary/state
- `trace.jsonl` for append-only structured events
- `artifacts/` for run-scoped outputs
- diagnostics handoff via `.mini-agent/diagnostics/last-run.json`

Practical result:

- each run now has a stable inspectable unit on disk
- diagnostics no longer depend on reconstructing everything from session logs
- append-only write behavior makes interrupted runs recoverable in a degraded mode instead of opaque

### 2.3 Runtime instrumentation

Delivered across:

- [src/runtime/run-manager.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/run-manager.ts)
- [src/runtime/loop.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/loop.ts)
- [src/runtime/agent.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/runtime/agent.ts)

What changed:

- runs now have explicit lifecycle ownership
- the loop emits trace events around planning, model requests, tool execution, assistant completion, and terminal outcomes
- sessions can optionally point back to the originating `runId`

Practical result:

- the session remains the conversation record
- the run trace becomes the execution record
- older sessions without run linkage still load; they simply report that no trace data is available

### 2.4 Live and offline CLI observability

Delivered across:

- [src/cli/timeline.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/cli/timeline.ts)
- [src/cli/run-report.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/cli/run-report.ts)
- [src/cli/main.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/cli/main.ts)
- [src/cli/repl.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/cli/repl.ts)
- [src/cli/doctor.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/cli/doctor.ts)

Exposed commands and surfaces:

- `mini-agent "<prompt>" --trace compact|verbose|json`
- `mini-agent run list`
- `mini-agent run show <run-id> [--format timeline|json|jsonl|markdown] [--verbose] [--recover]`
- `mini-agent session show <session-id> --trace [--run <run-id>]`
- `mini-agent doctor --last-run`
- `mini-agent doctor --run <run-id>`

Practical result:

- there is now a usable operator path for both live inspection and after-the-fact forensics
- maintainers can inspect a run directly without parsing raw files by hand
- markdown/json/jsonl output modes make the trace usable for both humans and scripts

### 2.5 Tool artifact and trace visibility

Delivered across:

- [src/tools/bash.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/bash.ts)
- [src/tools/write.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/write.ts)
- [src/tools/edit.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/edit.ts)
- [src/tools/activate-skill.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/tools/activate-skill.ts)

Specific behavior now present:

- bash commands create run-scoped artifact logs
- trace events can include bounded stdout/stderr tails for tool debugging
- write/edit operations register file artifacts
- skill activation reports resource counts
- new and modified file outputs are visible as trace artifacts rather than only as final filesystem state

Practical result:

- the trace is now materially useful for debugging real tool behavior
- artifact creation is no longer invisible when investigating a run

### 2.6 Cancellation semantics

Delivered:

- explicit `RUN_ABORTED` runtime error classification
- correct `run_cancelled` terminal event emission
- `meta.json` status of `cancelled` where appropriate
- narrower abort detection so unrelated provider failures after abort signaling are not overclassified as cancellations

Practical result:

- cancellation is now a first-class outcome instead of a disguised failure path
- postmortem diagnostics can distinguish user/operator interruption from runtime or provider failure

### 2.7 Operator diagnostics

Delivered in [src/cli/doctor.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/cli/doctor.ts):

- last-run and per-run summaries that include:
  - run status
  - first error code
  - error layer
  - trace health / trace status
  - trace path
  - artifacts directory
  - user-facing error message where applicable

Practical result:

- `doctor` is now useful as a post-failure entry point instead of only a config surface

### 2.8 Documentation updates

The main runtime implementation also updated maintainer-facing docs:

- [README.md](/Users/wangsiyuan/编程/小项目/mini-agent/README.md)
- [docs/README.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/README.md)
- [docs/reference/cli-and-config.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/reference/cli-and-config.md)
- [docs/reference/session-format.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/reference/session-format.md)

The `v1.2` spec itself is now also checked into the docs tree as:

- [docs/mini-agent-runtime-v1.2-spec.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/mini-agent-runtime-v1.2-spec.md)

### 2.9 Test coverage

Core regression coverage now includes:

- [tests/integration/runtime-observability.test.ts](/Users/wangsiyuan/编程/小项目/mini-agent/tests/integration/runtime-observability.test.ts)
- [tests/unit/run-store.test.ts](/Users/wangsiyuan/编程/小项目/mini-agent/tests/unit/run-store.test.ts)
- [tests/unit/timeline-renderer.test.ts](/Users/wangsiyuan/编程/小项目/mini-agent/tests/unit/timeline-renderer.test.ts)
- [tests/unit/run-report.test.ts](/Users/wangsiyuan/编程/小项目/mini-agent/tests/unit/run-report.test.ts)
- [tests/unit/repl.test.ts](/Users/wangsiyuan/编程/小项目/mini-agent/tests/unit/repl.test.ts)

The important point is not just that more tests exist. It is that the tests now cover the failure modes found during review rather than only the intended happy path.

## 3. What the review found and what was fixed

The user explicitly requested a full subagent review, including both spec review and code quality review. That happened in multiple rounds.

This was not ceremonial review. The reviewers found real correctness problems, and those problems were fixed before the implementation was treated as complete.

### 3.1 Issues found during the main review cycle

Fixed during review:

- aborted runs were being recorded as `run_failed` instead of `run_cancelled`
- verbose trace rendering was hiding debug telemetry that should have been visible in detailed mode
- degraded trace health was not consistently surfaced in viewers
- `doctor --last-run` was missing trace/log/error-layer detail needed for diagnosis
- failed bash commands could lose visibility into artifacts created before failure
- `doctor` output did not fully expose trace health state
- verbose trace output was missing stdout/stderr tails needed to debug tool failures
- aborted bash executions could be misreported as generic nonzero exits
- abort detection logic was too broad and could misclassify unrelated failures
- bash overwrite cases could drop artifact visibility
- `session show --trace` could swallow run-load failures instead of surfacing them
- markdown trace output was missing repair notes for degraded traces

Interpretation:

- the `v1.2` implementation was directionally correct on first landing
- it was not yet operationally solid until these review findings were fixed
- the resulting tree is materially better because the review was allowed to change runtime behavior rather than just comments and wording

### 3.2 Post-review live regression: duplicate REPL output

After the reviewed implementation was committed, live usage exposed another issue:

- REPL runs were printing each timeline event twice

Root cause:

- both [src/cli/main.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/cli/main.ts) and [src/cli/repl.ts](/Users/wangsiyuan/编程/小项目/mini-agent/src/cli/repl.ts) were subscribing to the same runtime event bus

Fix:

- a failing regression test was added in [tests/unit/repl.test.ts](/Users/wangsiyuan/编程/小项目/mini-agent/tests/unit/repl.test.ts)
- REPL-side duplicate subscription logic was removed so `main.ts` owns timeline rendering

Result:

- live REPL output now emits each trace line once
- the bug is covered by test and should not silently return

This fix landed in commit `019bc29`.

## 4. Current operational status

### 4.1 What is now in good shape

The following areas look solid enough to treat as completed `v1.2` behavior:

1. A first-class run record separate from the session log
2. Trace persistence with recoverable append-only storage
3. Live CLI timeline rendering
4. Offline trace inspection and reporting
5. Tool and artifact visibility sufficient for real debugging
6. Cancellation vs failure distinction
7. Run-aware doctor diagnostics
8. Compatibility with existing sessions through optional `runId`
9. Review-driven regression coverage on the main failure modes

### 4.2 What is intentionally not solved by v1.2

The following should not be treated as unfinished `v1.2` bugs unless the spec is changed:

- assistant token streaming
- a browser-based trace viewer
- OTel / LangSmith / external tracing export
- provider fallback chains
- multi-agent or subagent orchestration
- automatic compaction
- advanced trace filtering/search
- remote execution or sandbox infrastructure

The current implementation is an observable local runtime, not a full tracing platform.

### 4.3 Compatibility and migration posture

Current posture:

- old sessions continue to work
- sessions without a linked `runId` remain valid but cannot show trace data
- trace storage is additive beside the existing session system rather than a replacement for it

This is the right migration shape for the current project stage: it improves inspectability without forcing a storage-format reset.

## 5. Evidence and verification

Fresh verification after the duplicate-output fix:

- `npm run test:run -- tests/unit/repl.test.ts` passes
- `npm run check` passes
- `npm run build` passes

Current repository state at that point:

- 21 test files passing
- 69 tests passing

Relevant implementation commits:

- `34aa3e1` `feat(runtime): add observable run tracing`
- `019bc29` `fix(cli): avoid duplicate repl timeline output`

## 6. Recommended decisions for the spec author

At this point, the main uncertainty is no longer “does v1.2 exist?” It does. The uncertainty is what should happen next.

The most useful decisions for the spec author are these.

### 6.1 Decide whether `v1.2` is now closed

Recommendation:

- treat `v1.2` as complete unless a new requirement is introduced that was clearly intended by the spec and is still absent

Reasoning:

- the scoped observability layer is in place
- the review-found correctness issues were fixed
- the live regression reported after landing was also fixed
- further work now looks like next-iteration scope, not entry-gate cleanup

### 6.2 Decide what `v1.3` is actually about

The current codebase can go in several directions. Those should not be mixed casually into one vague next spec.

Plausible directions:

1. Operator UX
   - richer `run show` filtering
   - better trace summaries
   - ncurses/TUI or browser trace viewer

2. Integration/export
   - OpenTelemetry export
   - LangSmith-style trace export
   - machine-readable run bundle export/import

3. Runtime behavior
   - assistant token streaming
   - retry/fallback policy
   - richer interruption semantics

4. Evaluation/hardening
   - more live-provider smoke coverage
   - broader real-skill trace coverage
   - trace invariants and corruption testing

These are different projects. The next spec should choose one primary axis.

### 6.3 Freeze the trace contract before building external consumers

Recommendation:

- explicitly define which trace fields are stable contract
- identify which fields are debug-only and may change
- lock down artifact semantics for `bash`, `write`, and `edit`
- freeze the error taxonomy if downstream tooling will depend on it

Reasoning:

- the current trace model is already useful
- the moment an external viewer/exporter consumes it, accidental schema drift becomes real maintenance cost

### 6.4 Decide how much observability should live in `doctor`

Right now `doctor` is a practical diagnostic entry point. The next decision is whether it should remain report-oriented or become a stronger health-check surface.

Possible directions:

- keep it as a structured reporter for the last run / selected run
- add explicit smoke or integrity verification modes
- expose trace-store consistency checks

This is a product decision more than an implementation bug.

### 6.5 Decide how much real-world smoke validation is required before release

The current verification is strong on tests and local correctness. If the project wants a release-quality bar beyond that, define it explicitly.

Possible additions:

- one required live provider smoke command for each supported provider path
- one required real skill activation trace path
- one required tool-failure trace path

Without that decision, “release readiness” will stay subjective.

## 7. Suggested next-step plan

If the goal is to turn this handoff into a concrete next planning session, the clean sequence is:

1. Mark `v1.2` complete
2. Decide whether there should be a release/version bump tied to `v1.2`
3. Choose one primary `v1.3` axis:
   - viewer/export
   - runtime behavior
   - evaluation/hardening
4. Freeze the parts of the trace contract that downstream tooling will depend on
5. Write a narrower next spec instead of a broad “more observability” umbrella

That path avoids reopening already-closed `v1.2` work under a vague next milestone.

## 8. Bottom line

The current runtime now has an observable execution layer that did not exist before.

More importantly, it is not just “implemented on paper.” It has already gone through:

- main implementation
- full subagent spec/code-quality review
- multiple review-driven fixes
- regression testing
- one live-usage bug report and follow-up fix

That means the project is no longer deciding whether run observability is feasible. It is deciding how to use that new baseline.
