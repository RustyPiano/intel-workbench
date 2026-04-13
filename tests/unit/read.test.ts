import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createPolicyEngine } from "../../src/runtime/policy.js";
import type { ToolContext } from "../../src/tools/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
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
      toolTimeoutMs: 60_000,
      bashTimeoutMs: 120_000,
      maxBashOutputBytes: 64 * 1024,
      readMaxBytes: 32,
    },
  };
}

async function loadReadTool() {
  return (await import("../../src/tools/read.js")).readTool;
}

describe("readTool", () => {
  test("reads a text file and returns metadata", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, "notes.txt"), "hello runtime", "utf8");
    const readTool = await loadReadTool();

    const result = await readTool.execute({ path: "notes.txt" }, createContext(workspaceRoot));

    expect(result.ok).toBe(true);
    expect(result.content).toBe("hello runtime");
    expect(result.meta).toMatchObject({
      path: path.join(workspaceRoot, "notes.txt"),
      offset: 0,
      truncated: false,
    });
  });

  test("truncates output when the requested window is smaller than the file", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, "big.txt"), "abcdefghijklmnopqrstuvwxyz", "utf8");
    const readTool = await loadReadTool();

    const result = await readTool.execute({ path: "big.txt", limit: 5 }, createContext(workspaceRoot));

    expect(result.ok).toBe(true);
    expect(result.content).toBe("abcde");
    expect(result.meta).toMatchObject({
      truncated: true,
      limit: 5,
      size: 26,
    });
  });

  test("does not use readFile for bounded reads", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, "big.txt"), "abcdefghijklmnopqrstuvwxyz", "utf8");
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        readFile: vi.fn(async () => {
          throw new Error("readFile should not be called");
        }),
      };
    });
    const readTool = await loadReadTool();

    const result = await readTool.execute({ path: "big.txt", limit: 5 }, createContext(workspaceRoot));

    expect(result.ok).toBe(true);
  });

  test("avoids returning replacement characters when the byte window splits UTF-8 text", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, "utf8.txt"), "éa", "utf8");
    const readTool = await loadReadTool();

    const result = await readTool.execute({ path: "utf8.txt", offset: 1, limit: 2 }, createContext(workspaceRoot));

    expect(result.ok).toBe(true);
    expect(result.content).toBe("a");
    expect(result.content).not.toContain("\uFFFD");
  });
});
