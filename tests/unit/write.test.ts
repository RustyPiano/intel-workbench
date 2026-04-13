import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createPolicyEngine } from "../../src/runtime/policy.js";
import { FileMutationQueue } from "../../src/tools/file-mutation-queue.js";
import { writeTool } from "../../src/tools/write.js";
import type { ToolContext } from "../../src/tools/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-write-"));
  tempRoots.push(root);
  return root;
}

function createContext(workspaceRoot: string): ToolContext {
  return {
    workspaceRoot,
    sessionId: "sess_test",
    toolCallId: "call_write_1",
    signal: new AbortController().signal,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    skillRegistry: undefined,
    policy: createPolicyEngine({ workspaceRoot }),
    fileMutationQueue: new FileMutationQueue(),
    config: {
      toolTimeoutMs: 60_000,
      bashTimeoutMs: 120_000,
      maxBashOutputBytes: 64 * 1024,
      readMaxBytes: 256 * 1024,
    },
  };
}

describe("writeTool", () => {
  test("creates parent directories and writes the full file atomically", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await writeTool.execute(
      {
        path: "reports/output.txt",
        content: "fresh content",
        create_dirs: true,
        overwrite: true,
      },
      createContext(workspaceRoot),
    );

    expect(result.ok).toBe(true);
    expect(await readFile(path.join(workspaceRoot, "reports", "output.txt"), "utf8")).toBe("fresh content");
    await expect(access(path.join(workspaceRoot, "reports", "output.txt.tmp"))).rejects.toThrow();
  });

  test("returns a structured error when overwrite is disabled", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, "existing.txt"), "old", "utf8");

    const result = await writeTool.execute(
      {
        path: "existing.txt",
        content: "new",
        overwrite: false,
      },
      createContext(workspaceRoot),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: "INVALID_ARGS",
      message: "Refusing to overwrite existing file without overwrite=true",
    });
  });
});
