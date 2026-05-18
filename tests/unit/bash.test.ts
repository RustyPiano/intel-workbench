import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createPolicyEngine } from "../../src/runtime/policy.js";
import { bashTool } from "../../src/tools/bash.js";
import type { ToolContext } from "../../src/tools/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-bash-"));
  tempRoots.push(root);
  return root;
}

function createContext(
  workspaceRoot: string,
  toolCallId = "call_bash_1",
  configOverrides: Partial<ToolContext["config"]> = {},
): ToolContext {
  return {
    workspaceRoot,
    sessionId: "sess_test",
    runId: "run_test",
    toolCallId,
    signal: new AbortController().signal,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    skillRegistry: undefined,
    policy: createPolicyEngine({ workspaceRoot }),
    config: {
      toolTimeoutMs: 1_000,
      bashTimeoutMs: 100,
      maxBashOutputBytes: 16,
      readMaxBytes: 256 * 1024,
      ...configOverrides,
    },
  };
}

describe("bashTool", () => {
  test("captures command output and writes a bash artifact log", async () => {
    const workspaceRoot = await createWorkspace();
    const result = await bashTool.execute(
      {
        command: "printf 'stdout line\\n'; >&2 printf 'stderr line\\n'",
      },
      createContext(workspaceRoot, "call_bash_log"),
    );

    expect(result.ok).toBe(true);
    expect(result.meta).toMatchObject({
      exitCode: 0,
      logPath: ".mini-agent/runs/run_test/artifacts/bash/call_bash_log.log",
    });
    expect(result.artifacts).toContainEqual({
      type: "log",
      path: ".mini-agent/runs/run_test/artifacts/bash/call_bash_log.log",
      description: "Full bash output log",
    });
    const logPath = path.join(workspaceRoot, ".mini-agent", "runs", "run_test", "artifacts", "bash", "call_bash_log.log");
    expect(await readFile(logPath, "utf8")).toContain("stdout line");
    expect(await readFile(logPath, "utf8")).toContain("stderr line");
  });

  test("returns TOOL_TIMEOUT when the command exceeds the timeout", async () => {
    const workspaceRoot = await createWorkspace();
    const result = await bashTool.execute(
      {
        command: "node -e \"setTimeout(() => console.log('late'), 250)\"",
      },
      createContext(workspaceRoot, "call_bash_timeout"),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: "TOOL_TIMEOUT",
    });
  });

  test("returns RUN_ABORTED when the runtime signal aborts the command", async () => {
    const workspaceRoot = await createWorkspace();
    const controller = new AbortController();
    const pending = bashTool.execute(
      {
        command: "node -e \"setTimeout(() => console.log('late'), 500)\"",
      },
      {
        ...createContext(workspaceRoot, "call_bash_abort", { bashTimeoutMs: 1_000 }),
        signal: controller.signal,
      },
    );

    setTimeout(() => controller.abort(), 0);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: "RUN_ABORTED",
    });
  });

  test("caps per-call timeout requests at the runtime maximum", async () => {
    const workspaceRoot = await createWorkspace();
    const result = await bashTool.execute(
      {
        command: "node -e \"setTimeout(() => console.log('late'), 80)\"",
        timeout_ms: 1_000,
      },
      createContext(workspaceRoot, "call_bash_timeout_cap", { bashTimeoutMs: 25 }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: "TOOL_TIMEOUT",
    });
  });

  test("emits incremental updates while keeping only a bounded tail in memory", async () => {
    const workspaceRoot = await createWorkspace();
    const updates: string[] = [];
    const result = await bashTool.execute(
      {
        command:
          "node -e \"process.stdout.write('1234567890'); setTimeout(() => process.stdout.write('abcdefghij'), 20); setTimeout(() => process.exit(0), 40)\"",
      },
      {
        ...createContext(workspaceRoot, "call_bash_stream", { bashTimeoutMs: 1_000 }),
        onUpdate(partial) {
          updates.push(partial);
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(result.meta?.stdoutTail.length).toBeLessThanOrEqual(16);
    const logPath = path.join(
      workspaceRoot,
      ".mini-agent",
      "runs",
      "run_test",
      "artifacts",
      "bash",
      "call_bash_stream.log",
    );
    expect(await readFile(logPath, "utf8")).toContain("1234567890abcdefghij");
  });

  test("by default does not report workspace file mutations as artifacts", async () => {
    const workspaceRoot = await createWorkspace();
    const result = await bashTool.execute(
      {
        command: "printf 'report' > report.txt",
      },
      createContext(workspaceRoot, "call_bash_default_no_track"),
    );

    expect(result.ok).toBe(true);
    const fileArtifacts = (result.artifacts ?? []).filter((artifact) => artifact.type === "file");
    expect(fileArtifacts).toEqual([]);
    const logArtifacts = (result.artifacts ?? []).filter((artifact) => artifact.type === "log");
    expect(logArtifacts).toHaveLength(1);
  });

  test("reports files created before a nonzero exit as artifacts when track_artifacts is true", async () => {
    const workspaceRoot = await createWorkspace();
    const result = await bashTool.execute(
      {
        command: "printf 'report' > report.txt; exit 7",
        track_artifacts: true,
      },
      createContext(workspaceRoot, "call_bash_failure_artifact"),
    );

    expect(result.ok).toBe(false);
    expect(result.artifacts).toContainEqual({
      type: "file",
      path: "report.txt",
      description: "File created by bash command",
    });
  });

  test("reports overwritten output files as artifacts when track_artifacts is true", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, "report.txt"), "old", "utf8");

    const result = await bashTool.execute(
      {
        command: "printf 'new report' > report.txt",
        track_artifacts: true,
      },
      createContext(workspaceRoot, "call_bash_overwrite_artifact"),
    );

    expect(result.ok).toBe(true);
    expect(result.artifacts).toContainEqual({
      type: "file",
      path: "report.txt",
      description: "File created by bash command",
    });
  });

  test("ignores .git, dist, build, and other heavy directories when tracking artifacts", async () => {
    const workspaceRoot = await createWorkspace();
    await mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
    await writeFile(path.join(workspaceRoot, ".git", "HEAD"), "ref: refs/heads/main", "utf8");
    await mkdir(path.join(workspaceRoot, "dist"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "dist", "bundle.js"), "console.log(1)", "utf8");

    const result = await bashTool.execute(
      {
        // Touch a tracked file so we know snapshot diffing is working, but the
        // .git/HEAD and dist/bundle.js entries above must remain invisible to
        // the snapshot regardless of whether the command touches them.
        command: "printf 'tracked' > tracked.txt; touch .git/HEAD",
        track_artifacts: true,
      },
      createContext(workspaceRoot, "call_bash_ignore_check"),
    );

    expect(result.ok).toBe(true);
    const fileArtifacts = (result.artifacts ?? []).filter((artifact) => artifact.type === "file");
    expect(fileArtifacts.map((artifact) => artifact.path)).toContain("tracked.txt");
    expect(fileArtifacts.map((artifact) => artifact.path)).not.toContain(".git/HEAD");
    expect(fileArtifacts.map((artifact) => artifact.path)).not.toContain("dist/bundle.js");
  });

  test("caps the returned content to the configured tail budget", async () => {
    const workspaceRoot = await createWorkspace();
    const result = await bashTool.execute(
      {
        command: "node -e \"process.stdout.write('abc你def好')\"",
      },
      createContext(workspaceRoot, "call_bash_content_cap", {
        bashTimeoutMs: 1_000,
        maxBashOutputBytes: 8,
      }),
    );

    expect(result.ok).toBe(true);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(8);
    expect(result.content).not.toContain("\uFFFD");
  });
});
