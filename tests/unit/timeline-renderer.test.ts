import { describe, expect, test } from "vitest";

import { renderTimeline } from "../../src/cli/timeline.js";
import type { RunEvent } from "../../src/runtime/trace.js";

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

describe("renderTimeline", () => {
  test("renders compact mode from event summaries and hides debug details", () => {
    const lines = renderTimeline(
      [
        event({
          seq: 1,
          type: "planning_summary",
          phase: "planning",
          summary: "Plan next steps for the report",
          data: {
            kind: "plan",
            text: "Plan next steps for the report",
          },
        }),
        event({
          seq: 2,
          type: "model_request_started",
          phase: "model",
          level: "debug",
          summary: "Requesting model completion",
        }),
        event({
          seq: 3,
          type: "tool_started",
          phase: "tool",
          summary: "read README.md",
          data: {
            tool_name: "read",
            args_preview: "{\"path\":\"README.md\"}",
          },
        }),
        event({
          seq: 4,
          type: "run_completed",
          phase: "finalize",
          summary: "Run completed in 32ms",
          data: {
            duration_ms: 32,
            tool_calls: 1,
            skill_activations: 0,
            artifact_count: 0,
          },
        }),
      ],
      { mode: "compact" },
    );

    expect(lines).toEqual([
      "[plan] Plan next steps for the report",
      "[tool] read README.md",
      "[run] Run completed in 32ms",
    ]);
  });

  test("renders verbose mode with args and result previews", () => {
    const lines = renderTimeline(
      [
        event({
          seq: 1,
          type: "model_request_started",
          phase: "model",
          level: "debug",
          summary: "Requesting model completion",
          data: {
            provider: "openai-compatible",
            model: "gpt-4.1",
          },
        }),
        event({
          seq: 2,
          type: "tool_started",
          phase: "tool",
          summary: "bash python build.py",
          data: {
            tool_name: "bash",
            args_preview: "{\"command\":\"python build.py\"}",
          },
        }),
        event({
          seq: 3,
          type: "tool_progress",
          phase: "tool",
          level: "debug",
          summary: "bash progress",
          data: {
            chunk_preview: "step 1/2",
          },
        }),
        event({
          seq: 4,
          type: "tool_completed",
          phase: "tool",
          summary: "bash completed",
          data: {
            tool_name: "bash",
            ok: true,
            result_preview: "build ok",
            stdout_tail: "stdout ok",
            stderr_tail: "stderr tail",
            log_path: ".mini-agent/runs/run_test/artifacts/bash/call.log",
            duration_ms: 12,
          },
        }),
      ],
      { mode: "verbose" },
    );

    expect(lines[0]).toContain("provider=openai-compatible");
    expect(lines[0]).toContain("model=gpt-4.1");
    expect(lines[1]).toContain("[tool] bash python build.py");
    expect(lines[1]).toContain("args=");
    expect(lines[2]).toContain("chunk=step 1/2");
    expect(lines[3]).toContain("result=build ok");
    expect(lines[3]).toContain("stdout=stdout ok");
    expect(lines[3]).toContain("stderr=stderr tail");
    expect(lines[3]).toContain("log=.mini-agent/runs/run_test/artifacts/bash/call.log");
    expect(lines[3]).toContain("duration_ms=12");
  });

  test("renders failure lines with layer and next-step guidance", () => {
    const lines = renderTimeline(
      [
        event({
          seq: 1,
          type: "run_failed",
          phase: "error",
          level: "error",
          summary: "Run failed in tool_execution: command exited with code 1",
          data: {
            error_layer: "tool_execution",
            error_code: "tool_nonzero_exit",
            user_message: "The shell command failed. Check the command and its log file.",
          },
        }),
      ],
      { mode: "compact" },
    );

    expect(lines).toEqual([
      "[error] tool_execution: The shell command failed. Check the command and its log file.",
    ]);
  });
});
