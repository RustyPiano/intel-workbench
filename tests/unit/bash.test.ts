import { mkdtemp, readFile } from "node:fs/promises";
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

function createContext(workspaceRoot: string, toolCallId = "call_bash_1"): ToolContext {
  return {
    workspaceRoot,
    sessionId: "sess_test",
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
      bashTimeoutMs: 100,
      maxBashOutputBytes: 16,
      readMaxBytes: 256 * 1024,
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
    expect(result.data).toMatchObject({
      exitCode: 0,
      logPath: ".mini-agent/artifacts/bash/call_bash_log.log",
    });
    const logPath = path.join(workspaceRoot, ".mini-agent", "artifacts", "bash", "call_bash_log.log");
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
});
