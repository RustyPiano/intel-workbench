import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { EventBus } from "../../src/runtime/events.js";
import { RunManager } from "../../src/runtime/run-manager.js";
import { RunStore } from "../../src/runtime/run-store.js";
import type { RunMeta, RunStatus } from "../../src/runtime/trace.js";
import type { AssistantMessage, ToolCall } from "../../src/runtime/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-run-manager-"));
  tempRoots.push(root);
  return root;
}

async function bootstrap(): Promise<{
  manager: RunManager;
  eventBus: EventBus;
  runStore: RunStore;
  workspaceRoot: string;
  statusTrail: RunStatus[];
}> {
  const workspaceRoot = await createWorkspace();
  const eventBus = new EventBus();
  const runStore = new RunStore({ workspaceRoot });
  const statusTrail: RunStatus[] = [];

  const realUpdateMeta = runStore.updateMeta.bind(runStore);
  vi.spyOn(runStore, "updateMeta").mockImplementation(async (runId, patch) => {
    if (patch.status) {
      statusTrail.push(patch.status);
    }
    return realUpdateMeta(runId, patch);
  });

  const manager = await RunManager.start({
    workspaceRoot,
    sessionId: "sess_test",
    provider: "openai-compatible",
    model: "mock",
    eventBus,
    runStore,
    prompt: "Plan and run.",
    maxTurns: 4,
  });

  return { manager, eventBus, runStore, workspaceRoot, statusTrail };
}

function makeToolCall(name: string, id = "call_x"): ToolCall {
  return { id, name, arguments: { command: "echo hi" } };
}

function makeAssistantMessage(content = "Done."): AssistantMessage {
  return { role: "assistant", content };
}

async function readMetaStatus(runStore: RunStore, runId: string): Promise<RunStatus> {
  const meta = (await runStore.loadMeta(runId)) as RunMeta;
  return meta.status;
}

describe("RunManager state machine", () => {
  test("transitions monotonically: pending → running → finalizing → completed", async () => {
    const { manager, runStore, statusTrail } = await bootstrap();

    expect(statusTrail[0]).toBe("running");
    expect(await readMetaStatus(runStore, manager.runId)).toBe("running");

    await manager.emitPlanningSummary("plan", "Inspect the input.");
    expect(statusTrail).toEqual(["running"]);
    expect(await readMetaStatus(runStore, manager.runId)).toBe("running");

    await manager.recordToolStarted(makeToolCall("bash"));
    await manager.recordToolProgress(makeToolCall("bash"), "step 1");
    expect(statusTrail).toEqual(["running"]);
    expect(await readMetaStatus(runStore, manager.runId)).toBe("running");

    await manager.recordToolCompleted(makeToolCall("bash"), {
      ok: true,
      content: "ok",
    });

    await manager.recordAssistantCompleted(makeAssistantMessage());
    expect(statusTrail[statusTrail.length - 1]).toBe("finalizing");
    expect(await readMetaStatus(runStore, manager.runId)).toBe("finalizing");

    await manager.complete();
    expect(statusTrail[statusTrail.length - 1]).toBe("completed");
    expect(await readMetaStatus(runStore, manager.runId)).toBe("completed");

    const rank: Record<RunStatus, number> = {
      pending: 0,
      running: 1,
      finalizing: 2,
      completed: 3,
      failed: 3,
      cancelled: 3,
    };
    let previousRank = -1;
    for (const status of statusTrail) {
      expect(rank[status]).toBeGreaterThanOrEqual(previousRank);
      previousRank = rank[status];
    }
  });

  test("emitPlanningSummary does not change meta.status", async () => {
    const { manager, runStore, statusTrail } = await bootstrap();

    const before = await readMetaStatus(runStore, manager.runId);
    await manager.emitPlanningSummary("plan", "Look around.");
    await manager.emitPlanningSummary("decision", "Edit file.");
    await manager.emitPlanningSummary("progress", "Compiling.");
    const after = await readMetaStatus(runStore, manager.runId);

    expect(before).toBe("running");
    expect(after).toBe("running");
    // Only the initial pending→running write should be in the trail.
    expect(statusTrail).toEqual(["running"]);
  });

  test("tool_progress only emits an event and does not change status", async () => {
    const { manager, eventBus, runStore, statusTrail } = await bootstrap();

    statusTrail.length = 0;
    await manager.recordToolProgress(makeToolCall("bash"), "still running");

    const events = eventBus.getBufferedEvents();
    expect(events.some((event) => event.type === "tool_progress")).toBe(true);
    expect(statusTrail).toEqual([]);
    expect(await readMetaStatus(runStore, manager.runId)).toBe("running");
  });

  test("duration is computed against startedAtMs with fake timers", async () => {
    vi.useFakeTimers();
    const startInstant = new Date("2026-05-18T00:00:00.000Z").getTime();
    vi.setSystemTime(startInstant);

    try {
      const { manager, eventBus } = await bootstrap();

      vi.setSystemTime(startInstant + 2500);
      await manager.complete();

      const completedEvent = eventBus
        .getBufferedEvents()
        .find((event) => event.type === "run_completed");
      expect(completedEvent).toBeDefined();
      expect(completedEvent?.data?.duration_ms).toBe(2500);
    } finally {
      vi.useRealTimers();
    }
  });

  test("fail records a terminal failed status without regression", async () => {
    const { manager, runStore, statusTrail } = await bootstrap();

    await manager.fail({
      code: "MODEL_ERROR",
      message: "boom",
      details: { category: "network" },
    });

    expect(statusTrail[statusTrail.length - 1]).toBe("failed");
    expect(await readMetaStatus(runStore, manager.runId)).toBe("failed");
    // Re-invoking does not produce another status update.
    const trailLength = statusTrail.length;
    await manager.fail({ code: "MODEL_ERROR", message: "ignored" });
    expect(statusTrail.length).toBe(trailLength);
  });

  test("cancel records a terminal cancelled status without regression", async () => {
    const { manager, runStore, statusTrail } = await bootstrap();

    await manager.cancel({ code: "RUN_ABORTED", message: "aborted", retriable: true });

    expect(statusTrail[statusTrail.length - 1]).toBe("cancelled");
    expect(await readMetaStatus(runStore, manager.runId)).toBe("cancelled");
  });
});
