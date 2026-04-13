import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createPolicyEngine } from "../../src/runtime/policy.js";
import { readTool } from "../../src/tools/read.js";
import type { ToolContext } from "../../src/tools/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-read-"));
  tempRoots.push(root);
  return root;
}

function createContext(workspaceRoot: string): ToolContext {
  return {
    workspaceRoot,
    sessionId: "sess_test",
    toolCallId: "call_read_1",
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
      bashTimeoutMs: 120_000,
      maxBashOutputBytes: 64 * 1024,
      readMaxBytes: 32,
    },
  };
}

describe("readTool", () => {
  test("reads a text file and returns metadata", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, "notes.txt"), "hello runtime", "utf8");

    const result = await readTool.execute({ path: "notes.txt" }, createContext(workspaceRoot));

    expect(result.ok).toBe(true);
    expect(result.content).toBe("hello runtime");
    expect(result.data).toMatchObject({
      path: path.join(workspaceRoot, "notes.txt"),
      offset: 0,
      truncated: false,
    });
  });

  test("truncates output when the requested window is smaller than the file", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, "big.txt"), "abcdefghijklmnopqrstuvwxyz", "utf8");

    const result = await readTool.execute({ path: "big.txt", limit: 5 }, createContext(workspaceRoot));

    expect(result.ok).toBe(true);
    expect(result.content).toBe("abcde");
    expect(result.data).toMatchObject({
      truncated: true,
      limit: 5,
      size: 26,
    });
  });
});
