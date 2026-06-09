import { describe, expect, test } from "vitest";

import { formatRunTraceReport, formatSessionTraceReport } from "../../src/cli/run-report.js";
import type { LoadedRunTrace, RunEvent, RunMeta } from "../../src/runtime/trace.js";

function event(overrides: Partial<RunEvent> & Pick<RunEvent, "seq" | "type" | "phase" | "summary">): RunEvent {
  return {
    schema_version: "v1.2",
    event_id: `evt_${overrides.seq}`,
    trace_id: "trace_test",
    run_id: "run_test",
    session_id: "sess_test",
    ts: `2026-04-13T00:00:0${overrides.seq}.000Z`,
    level: "info",
    data: {},
    ...overrides,
  };
}

function loadedRunTrace(partial: Partial<LoadedRunTrace> = {}): LoadedRunTrace {
  const meta: RunMeta = {
    run_id: "run_test",
    trace_id: "trace_test",
    session_id: "sess_test",
    status: "completed",
    started_at: "2026-04-13T00:00:00.000Z",
    duration_ms: 32,
    provider: "openai-compatible",
    model: "mock",
    tool_calls: 1,
    skill_activations: 0,
    artifact_count: 0,
  };

  return {
    meta,
    events: [
      event({ seq: 1, type: "run_started", phase: "system", summary: "Started run" }),
      event({ seq: 2, type: "planning_summary", phase: "planning", summary: "Inspect the workspace first" }),
      event({ seq: 3, type: "tool_started", phase: "tool", summary: "read README.md" }),
      event({ seq: 4, type: "run_completed", phase: "finalize", summary: "Run completed in 32ms" }),
    ],
    status: "valid",
    repairNotes: [],
    tracePath: "/tmp/trace.jsonl",
    metaPath: "/tmp/meta.json",
    ...partial,
  };
}

describe("run report formatting", () => {
  test("formats a run trace as markdown", () => {
    const report = formatRunTraceReport(loadedRunTrace(), {
      format: "markdown",
      mode: "compact",
    });

    expect(report).toContain("# Run run_test");
    expect(report).toContain("- [plan] Inspect the workspace first");
    expect(report).toContain("- [tool] read README.md");
  });

  test("formats session traces and degrades cleanly when no run traces exist", () => {
    expect(
      formatSessionTraceReport(
        {
          sessionId: "sess_empty",
          sessionStatus: "valid",
          runTraces: [],
        },
        { mode: "compact" },
      ),
    ).toContain("trace\t(no trace data)");

    const report = formatSessionTraceReport(
      {
        sessionId: "sess_test",
        sessionStatus: "valid",
        runTraces: [loadedRunTrace()],
      },
      { mode: "compact" },
    );

    expect(report).toContain("session\tsess_test");
    expect(report).toContain("session_status\tvalid");
    expect(report).toContain("run\trun_test");
    expect(report).toContain("trace_status\tvalid");
    expect(report).toContain("[run] Run completed in 32ms");
  });

  test("surfaces degraded trace health even without repair notes", () => {
    const report = formatRunTraceReport(
      loadedRunTrace({
        status: "degraded",
      }),
      { format: "timeline", mode: "compact" },
    );

    expect(report).toContain("trace_status\tdegraded");
  });

  test("includes repair notes in markdown output for degraded traces", () => {
    const report = formatRunTraceReport(
      loadedRunTrace({
        status: "degraded",
        repairNotes: ["invalid json at line 4"],
      }),
      { format: "markdown", mode: "compact" },
    );

    expect(report).toContain("## Repair Notes");
    expect(report).toContain("- invalid json at line 4");
  });
});
