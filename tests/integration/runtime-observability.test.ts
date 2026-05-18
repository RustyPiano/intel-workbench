import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { renderTimeline } from "../../src/cli/timeline.js";
import { ScriptedModelAdapter } from "../../src/model/mock.js";
import { RuntimeError } from "../../src/runtime/errors.js";
import { RuntimeAgent } from "../../src/runtime/agent.js";
import { RunStore } from "../../src/runtime/run-store.js";

const tempRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-observable-"));
  tempRoots.push(root);
  return root;
}

async function createIntelBulletinSkill(workspaceRoot: string) {
  const skillRoot = path.join(workspaceRoot, ".agents", "skills", "intel-bulletin");
  await mkdir(path.join(skillRoot, "scripts"), { recursive: true });

  await writeFile(
    path.join(skillRoot, "SKILL.md"),
    `---
name: intel-bulletin
description: Build a bulletin from source notes.
compatibility: Requires Python 3.11+
allowed-tools: read write edit bash activate_skill
---

# Intel Bulletin

Use this skill to turn source notes into a formal report.
`,
    "utf8",
  );

  await writeFile(
    path.join(skillRoot, "scripts", "render_report.py"),
    [
      "from pathlib import Path",
      "import sys",
      "",
      "source = Path(sys.argv[1]).read_text(encoding='utf-8')",
      "output = Path(sys.argv[2])",
      "output.write_text('REPORT\\n' + source, encoding='utf-8')",
    ].join("\n"),
    "utf8",
  );
}

describe("runtime observability", () => {
  test("writes run traces, artifacts, and last-run diagnostics for a successful run", async () => {
    const workspaceRoot = await createWorkspace();
    await createIntelBulletinSkill(workspaceRoot);
    await writeFile(path.join(workspaceRoot, "source.txt"), "briefing notes\n", "utf8");

    const model = new ScriptedModelAdapter([
      {
        message: {
          role: "assistant",
          content: "I need the bulletin skill.",
          toolCalls: [{ id: "call_activate", name: "activate_skill", arguments: { name: "intel-bulletin" } }],
        },
        stopReason: "tool_use",
      },
      {
        message: {
          role: "assistant",
          content: "I will render the report.",
          toolCalls: [
            {
              id: "call_bash",
              name: "bash",
              arguments: {
                command: "python3 .agents/skills/intel-bulletin/scripts/render_report.py source.txt report.txt",
                track_artifacts: true,
              },
            },
          ],
        },
        stopReason: "tool_use",
      },
      {
        message: {
          role: "assistant",
          content: "Report rendered.",
        },
        stopReason: "end_turn",
      },
    ]);

    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.2.0",
      modelName: "mock",
      providerName: "openai-compatible",
      modelAdapter: model,
    });

    const result = await agent.run("Generate an intel bulletin report.");
    expect(result.finalMessage.content).toBe("Report rendered.");

    const runStore = new RunStore({ workspaceRoot });
    const runs = await runStore.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      session_id: result.sessionId,
      status: "completed",
      provider: "openai-compatible",
      model: "mock",
      tool_calls: 2,
      skill_activations: 1,
    });

    const trace = await runStore.loadTrace(runs[0]!.run_id);
    expect(trace.events[0]?.type).toBe("run_started");
    expect(trace.events.at(-1)?.type).toBe("run_completed");
    expect(trace.events.some((entry) => entry.type === "planning_summary")).toBe(true);
    expect(trace.events.some((entry) => entry.type === "skill_activated")).toBe(true);
    expect(trace.events.some((entry) => entry.type === "artifact_created" && String(entry.data?.path).includes("report"))).toBe(true);

    const timeline = renderTimeline(trace.events, { mode: "compact" });
    expect(timeline.some((line) => line.startsWith("[plan]"))).toBe(true);
    expect(timeline.some((line) => line.includes("intel-bulletin"))).toBe(true);

    const diagnosticsPath = path.join(workspaceRoot, ".mini-agent", "diagnostics", "last-run.json");
    const diagnostics = JSON.parse(await readFile(diagnosticsPath, "utf8")) as Record<string, unknown>;
    expect(diagnostics).toMatchObject({
      run_id: runs[0]!.run_id,
      status: "completed",
      trace_status: "valid",
    });
  });

  test("records provider failures as failed runs with mapped error categories", async () => {
    const workspaceRoot = await createWorkspace();
    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.2.0",
      modelName: "mock",
      providerName: "openai-compatible",
      modelAdapter: {
        name: "mock",
        async generate() {
          throw new RuntimeError({
            code: "MODEL_ERROR",
            message: "429 quota exceeded",
            details: { category: "quota" },
          });
        },
      },
    });

    await expect(agent.run("Trigger provider quota failure.")).rejects.toThrow("429 quota exceeded");

    const runStore = new RunStore({ workspaceRoot });
    const runs = await runStore.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "failed",
      first_error_code: "provider_quota_error",
    });

    const trace = await runStore.loadTrace(runs[0]!.run_id);
    const failed = trace.events.at(-1);
    expect(failed).toMatchObject({
      type: "run_failed",
      data: {
        error_layer: "provider",
        error_code: "provider_quota_error",
      },
    });
  });

  test("records aborted runs as cancelled instead of failed", async () => {
    const workspaceRoot = await createWorkspace();
    const controller = new AbortController();

    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.2.0",
      modelName: "mock",
      providerName: "openai-compatible",
      modelAdapter: {
        name: "mock",
        async generate(input) {
          return await new Promise((_, reject) => {
            if (input.signal?.aborted) {
              reject(
                new RuntimeError({
                  code: "RUN_ABORTED",
                  message: "aborted",
                  retriable: true,
                }),
              );
              return;
            }
            input.signal?.addEventListener(
              "abort",
              () => {
                reject(
                  new RuntimeError({
                    code: "RUN_ABORTED",
                    message: "aborted",
                    retriable: true,
                  }),
                );
              },
              { once: true },
            );
          });
        },
      },
    });

    const pending = agent.run("Abort this run.", controller.signal);
    setTimeout(() => controller.abort(), 0);
    await expect(pending).rejects.toThrow("aborted");

    const runStore = new RunStore({ workspaceRoot });
    const runs = await runStore.listRuns();
    expect(runs[0]).toMatchObject({
      status: "cancelled",
      first_error_code: "run_aborted",
    });

    const trace = await runStore.loadTrace(runs[0]!.run_id);
    expect(trace.events.at(-1)).toMatchObject({
      type: "run_cancelled",
      data: {
        error_layer: "user_abort",
        error_code: "run_aborted",
      },
    });
  });

  test("preserves provider failures even if an abort signal is raised mid-request", async () => {
    const workspaceRoot = await createWorkspace();
    const controller = new AbortController();

    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.2.0",
      modelName: "mock",
      providerName: "openai-compatible",
      modelAdapter: {
        name: "mock",
        async generate() {
          setTimeout(() => controller.abort(), 0);
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new RuntimeError({
            code: "MODEL_ERROR",
            message: "429 quota exceeded",
            details: { category: "quota" },
          });
        },
      },
    });

    await expect(agent.run("Trigger quota failure after abort.", controller.signal)).rejects.toThrow("429 quota exceeded");

    const runStore = new RunStore({ workspaceRoot });
    const trace = await runStore.loadTrace((await runStore.listRuns())[0]!.run_id);
    expect(trace.events.at(-1)).toMatchObject({
      type: "run_failed",
      data: {
        error_layer: "provider",
        error_code: "provider_quota_error",
      },
    });
  });
});
