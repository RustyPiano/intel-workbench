import { appendFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { classifyRunFailure, createTraceSummary, type RunEvent } from "../../src/runtime/trace.js";
import { RunStore } from "../../src/runtime/run-store.js";

const tempRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-runs-"));
  tempRoots.push(root);
  return root;
}

function makeEvent(
  created: Awaited<ReturnType<RunStore["createRun"]>>,
  overrides: Partial<RunEvent> & Pick<RunEvent, "seq" | "type" | "phase" | "summary">,
): RunEvent {
  return {
    schema_version: "v1.2",
    event_id: `evt_${overrides.seq}`,
    trace_id: created.traceId,
    run_id: created.runId,
    session_id: "sess_test",
    ts: `2026-04-13T00:00:0${overrides.seq}.000Z`,
    level: "info",
    data: {},
    ...overrides,
  };
}

describe("RunStore", () => {
  test("throws a friendly RUN_NOT_FOUND for an unknown run id", async () => {
    const workspaceRoot = await createWorkspace();
    const store = new RunStore({ workspaceRoot });

    await expect(store.loadMeta("run_does_not_exist")).rejects.toMatchObject({
      code: "RUN_NOT_FOUND",
      message: "Run not found: run_does_not_exist",
    });
    // loadTrace reads meta first, so it surfaces the same friendly error.
    await expect(store.loadTrace("run_does_not_exist")).rejects.toMatchObject({
      code: "RUN_NOT_FOUND",
    });
  });

  test("writes run traces and recovers the longest valid prefix", async () => {
    const workspaceRoot = await createWorkspace();
    const store = new RunStore({ workspaceRoot });
    const created = await store.createRun({
      sessionId: "sess_test",
      provider: "openai-compatible",
      model: "mock",
      startedAt: "2026-04-13T00:00:00.000Z",
    });

    await store.appendEvent(
      makeEvent(created, {
        seq: 1,
        type: "run_started",
        phase: "system",
        summary: "Started run for prompt",
        data: {
          input_preview: "Generate a report",
          cwd: workspaceRoot,
          max_turns: 4,
        },
      }),
    );
    await store.appendEvent(
      makeEvent(created, {
        seq: 2,
        type: "run_completed",
        phase: "finalize",
        summary: "Run completed in 10ms",
        data: {
          duration_ms: 10,
          tool_calls: 0,
          skill_activations: 0,
          artifact_count: 0,
        },
      }),
    );
    await store.finalizeRun(created.runId, {
      status: "completed",
      endedAt: "2026-04-13T00:00:00.010Z",
      durationMs: 10,
      toolCalls: 0,
      skillActivations: 0,
      artifactCount: 0,
    });

    const loaded = await store.loadTrace(created.runId);
    expect(loaded.status).toBe("valid");
    expect(loaded.events.map((event) => event.type)).toEqual(["run_started", "run_completed"]);
    expect(loaded.meta).toMatchObject({
      run_id: created.runId,
      session_id: "sess_test",
      status: "completed",
      tool_calls: 0,
      skill_activations: 0,
      artifact_count: 0,
    });

    await appendFile(created.tracePath, '{"oops": }\n', "utf8");

    const recovered = await store.loadTrace(created.runId, { mode: "recover" });
    expect(recovered.status).toBe("degraded");
    expect(recovered.events.map((event) => event.type)).toEqual(["run_started", "run_completed"]);
    expect(recovered.repairNotes.some((note) => note.includes("invalid json"))).toBe(true);
  });

  test("lists newest runs first", async () => {
    const workspaceRoot = await createWorkspace();
    const store = new RunStore({ workspaceRoot });

    const older = await store.createRun({
      sessionId: "sess_older",
      provider: "openai-compatible",
      model: "mock",
      startedAt: "2026-04-13T00:00:00.000Z",
    });
    await store.finalizeRun(older.runId, { status: "completed" });

    const newer = await store.createRun({
      sessionId: "sess_newer",
      provider: "openai-compatible",
      model: "mock",
      startedAt: "2026-04-13T00:10:00.000Z",
    });
    await store.finalizeRun(newer.runId, { status: "completed" });

    const runs = await store.listRuns();
    expect(runs.map((run) => run.run_id)).toEqual([newer.runId, older.runId]);
  });
});

describe("trace helpers", () => {
  test("redacts secrets and truncates summaries", () => {
    const summary = createTraceSummary(
      "Authorization: Bearer sk-live-super-secret-token and OPENAI_API_KEY=sk-live-second-secret-token",
      60,
    );

    expect(summary).toContain("[REDACTED]");
    expect(summary).not.toContain("sk-live");
    expect(summary.length).toBeLessThanOrEqual(60);
  });

  test("maps runtime errors into operator-facing failure categories", () => {
    expect(
      classifyRunFailure({
        code: "MODEL_ERROR",
        message: "429 quota exceeded",
        details: { category: "quota" },
      }),
    ).toMatchObject({
      error_code: "provider_quota_error",
      error_layer: "provider",
    });

    expect(
      classifyRunFailure({
        code: "MODEL_ERROR",
        message: "Provider returned malformed chat completion response: missing choices array",
        details: { category: "incompatible_response" },
      }),
    ).toMatchObject({
      error_code: "provider_incompatibility",
      error_layer: "provider",
    });

    expect(
      classifyRunFailure({
        code: "PROCESS_EXIT_NONZERO",
        message: "Command exited with code 2",
      }),
    ).toMatchObject({
      error_code: "tool_nonzero_exit",
      error_layer: "tool_execution",
    });
  });
});
