import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createPolicyEngine } from "../../src/runtime/policy.js";
import { ToolRegistry } from "../../src/tools/index.js";
import { readTool } from "../../src/tools/read.js";
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

function createContext(workspaceRoot: string, readMaxBytes = 256 * 1024): ToolContext {
  return {
    workspaceRoot,
    sessionId: "sess_test",
    runId: "run_test",
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
      readMaxBytes,
    },
  };
}

async function loadReadTool() {
  return (await import("../../src/tools/read.js")).readTool;
}

describe("readTool", () => {
  test("reads a text file with cat -n line numbers and returns metadata", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, "notes.txt"), "hello runtime", "utf8");
    const readTool = await loadReadTool();

    const result = await readTool.execute({ path: "notes.txt" }, createContext(workspaceRoot));

    expect(result.ok).toBe(true);
    expect(result.content).toBe("     1\thello runtime");
    expect(result.meta).toMatchObject({
      path: path.join(workspaceRoot, "notes.txt"),
      offset: 1,
      limit: 2000,
      lines: 1,
      truncated: false,
      size: 13,
    });
  });

  test("numbers every line and preserves blank lines", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, "multi.txt"), "alpha\n\nbravo\n", "utf8");
    const readTool = await loadReadTool();

    const result = await readTool.execute({ path: "multi.txt" }, createContext(workspaceRoot));

    expect(result.ok).toBe(true);
    expect(result.content).toBe("     1\talpha\n     2\t\n     3\tbravo");
    expect(result.meta).toMatchObject({ lines: 3, truncated: false });
  });

  test("does not read workspace secret files", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, ".env"), "MINI_AGENT_API_KEY=secret\n", "utf8");
    const readTool = await loadReadTool();

    const result = await readTool.execute({ path: ".env" }, createContext(workspaceRoot));

    expect(result.ok).toBe(false);
    expect(result.content).toContain("not readable by tools");
    expect(result.content).not.toContain("MINI_AGENT_API_KEY");
  });

  test("applies a 1-based line offset and limit", async () => {
    const workspaceRoot = await createWorkspace();
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    await writeFile(path.join(workspaceRoot, "many.txt"), `${lines}\n`, "utf8");
    const readTool = await loadReadTool();

    const result = await readTool.execute({ path: "many.txt", offset: 3, limit: 2 }, createContext(workspaceRoot));

    expect(result.ok).toBe(true);
    expect(result.content).toBe("     3\tline 3\n     4\tline 4");
    expect(result.meta).toMatchObject({ offset: 3, limit: 2, lines: 2, truncated: true });
  });

  test("flags truncation when the file has more lines than the limit", async () => {
    const workspaceRoot = await createWorkspace();
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    await writeFile(path.join(workspaceRoot, "many.txt"), `${lines}\n`, "utf8");
    const readTool = await loadReadTool();

    const result = await readTool.execute({ path: "many.txt", limit: 5 }, createContext(workspaceRoot));

    expect(result.ok).toBe(true);
    expect(result.content.split("\n")).toHaveLength(5);
    expect(result.content.startsWith("     1\tline 1")).toBe(true);
    expect(result.meta).toMatchObject({ limit: 5, lines: 5, truncated: true });
  });

  test("does not use readFile to slurp the whole file", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, "big.txt"), "a\nb\nc\nd\ne", "utf8");
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

    const result = await readTool.execute({ path: "big.txt", limit: 2 }, createContext(workspaceRoot));

    expect(result.ok).toBe(true);
  });

  test("drops a partial multibyte char at the byte-cap boundary without replacement chars", async () => {
    const workspaceRoot = await createWorkspace();
    // readMaxBytes is 32 in the test context. 31 ASCII bytes + a 3-byte "中"
    // makes the 32-byte window land inside the multibyte sequence.
    await writeFile(path.join(workspaceRoot, "utf8.txt"), `${"a".repeat(31)}中`, "utf8");
    const readTool = await loadReadTool();

    const result = await readTool.execute({ path: "utf8.txt" }, createContext(workspaceRoot, 32));

    expect(result.ok).toBe(true);
    expect(result.content).toBe(`     1\t${"a".repeat(31)}`);
    expect(result.content).not.toContain("�");
    expect(result.meta).toMatchObject({ truncated: true });
  });

  test("rejects unknown arguments via the strict tool schema", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, "notes.txt"), "hello", "utf8");
    const registry = new ToolRegistry([readTool]);

    const result = await registry.execute(
      {
        id: "call_read_unknown",
        name: "read",
        arguments: { path: "notes.txt", encoding: "utf8" },
      },
      createContext(workspaceRoot),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "INVALID_ARGS" });
  });
});
