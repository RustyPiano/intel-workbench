import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const hasFfprobe = spawnSync("ffprobe", ["-version"]).status === 0;

import { createPolicyEngine } from "../../src/runtime/policy.js";
import { ToolRegistry } from "../../src/tools/index.js";
import { probeMediaTool } from "../../src/tools/probe-media.js";
import type { ToolContext } from "../../src/tools/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-probe-"));
  tempRoots.push(root);
  return root;
}

function createContext(workspaceRoot: string): ToolContext {
  return {
    workspaceRoot,
    sessionId: "sess_test",
    runId: "run_test",
    toolCallId: "call_probe_1",
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    skillRegistry: undefined,
    policy: createPolicyEngine({ workspaceRoot }),
    config: {
      toolTimeoutMs: 60_000,
      bashTimeoutMs: 120_000,
      maxBashOutputBytes: 64 * 1024,
      readMaxBytes: 256 * 1024,
    },
  };
}

describe("probeMediaTool", () => {
  test("returns ok:false for a missing media file (ffprobe error or ffprobe absent)", async () => {
    const workspaceRoot = await createWorkspace();
    const result = await probeMediaTool.execute({ path: "missing.mp4" }, createContext(workspaceRoot));

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("rejects unknown arguments via the strict tool schema", async () => {
    const workspaceRoot = await createWorkspace();
    const registry = new ToolRegistry([probeMediaTool]);

    const result = await registry.execute(
      { id: "call_probe_unknown", name: "probe_media", arguments: { path: "x.mp4", verbose: true } },
      createContext(workspaceRoot),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "INVALID_ARGS" });
  });

  test.skipIf(!(hasFfmpeg && hasFfprobe))("parses a real audio file's duration and streams", async () => {
    const workspaceRoot = await createWorkspace();
    const wavPath = path.join(workspaceRoot, "tone.wav");
    // 1-second 440Hz sine — small, deterministic, no network.
    await execFileAsync("ffmpeg", ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-y", wavPath]);

    const result = await probeMediaTool.execute({ path: "tone.wav" }, createContext(workspaceRoot));

    expect(result.ok).toBe(true);
    const meta = result.meta as { hasAudio: boolean; hasVideo: boolean; durationSeconds: number | null };
    expect(meta.hasAudio).toBe(true);
    expect(meta.hasVideo).toBe(false);
    expect(meta.durationSeconds).toBeGreaterThan(0.5);
  });
});
