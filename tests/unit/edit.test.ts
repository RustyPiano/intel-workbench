import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createPolicyEngine } from "../../src/runtime/policy.js";
import { editTool } from "../../src/tools/edit.js";
import { FileMutationQueue } from "../../src/tools/file-mutation-queue.js";
import type { ToolContext } from "../../src/tools/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-edit-"));
  tempRoots.push(root);
  return root;
}

function createContext(workspaceRoot: string): ToolContext {
  return {
    workspaceRoot,
    sessionId: "sess_test",
    toolCallId: "call_edit_1",
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
      bashTimeoutMs: 120_000,
      maxBashOutputBytes: 64 * 1024,
      readMaxBytes: 256 * 1024,
    },
  };
}

describe("editTool", () => {
  test("matches normalized text and rewrites the file with LF endings", async () => {
    const workspaceRoot = await createWorkspace();
    const filePath = path.join(workspaceRoot, "README.md");
    await writeFile(filePath, "\uFEFFStatus:\r\n“TODO” — pending\r\n", "utf8");

    const result = await editTool.execute(
      {
        path: "README.md",
        old_text: "\"TODO\" - pending",
        new_text: "\"DONE\" - shipped",
      },
      createContext(workspaceRoot),
    );

    expect(result.ok).toBe(true);
    expect(await readFile(filePath, "utf8")).toBe("Status:\n\"DONE\" - shipped\n");
  });

  test("returns EDIT_AMBIGUOUS when multiple matches exist and replace_all is false", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, "notes.md"), "TODO\nTODO\n", "utf8");

    const result = await editTool.execute(
      {
        path: "notes.md",
        old_text: "TODO",
        new_text: "DONE",
      },
      createContext(workspaceRoot),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: "EDIT_AMBIGUOUS",
    });
  });
});
