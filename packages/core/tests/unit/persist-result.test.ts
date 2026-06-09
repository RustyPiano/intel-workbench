import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createPolicyEngine } from "../../src/runtime/policy.js";
import { FileMutationQueue } from "../../src/tools/file-mutation-queue.js";
import { persistToolResult } from "../../src/tools/utils/persist-result.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-persist-"));
  tempRoots.push(root);
  return root;
}

describe("persistToolResult", () => {
  test("resolves the output path, creates parent dirs, and writes pretty JSON", async () => {
    const root = await createWorkspace();

    const result = await persistToolResult({
      ctx: {
        policy: createPolicyEngine({ workspaceRoot: root }),
      },
      outPath: "analysis/result.json",
      data: { ok: true, nested: { value: 1 } },
    });

    expect(result.absPath).toBe(path.join(root, "analysis/result.json"));
    const written = await readFile(result.absPath, "utf8");
    expect(written).toBe('{\n  "ok": true,\n  "nested": {\n    "value": 1\n  }\n}\n');
    expect(result.bytesWritten).toBe(Buffer.byteLength(written, "utf8"));
  });

  test("uses fileMutationQueue when present", async () => {
    const root = await createWorkspace();
    class RecordingQueue extends FileMutationQueue {
      seenPath: string | undefined;

      override async runExclusive<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
        this.seenPath = filePath;
        return operation();
      }
    }
    const queue = new RecordingQueue();

    const result = await persistToolResult({
      ctx: {
        policy: createPolicyEngine({ workspaceRoot: root }),
        fileMutationQueue: queue,
      },
      outPath: "queued/out.json",
      data: ["x"],
    });

    expect(queue.seenPath).toBe(result.absPath);
    await expect(readFile(result.absPath, "utf8")).resolves.toBe('[\n  "x"\n]\n');
  });

  test("surfaces read-only policy failures as PATH_NOT_ALLOWED", async () => {
    const root = await createWorkspace();

    await expect(
      persistToolResult({
        ctx: {
          policy: createPolicyEngine({ workspaceRoot: root, readOnly: true }),
        },
        outPath: "analysis/result.json",
        data: { ok: true },
      }),
    ).rejects.toMatchObject({
      name: "RuntimeError",
      code: "PATH_NOT_ALLOWED",
      message: expect.stringMatching(/not writable/u),
    });
  });
});
