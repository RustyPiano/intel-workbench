import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createPolicyEngine } from "../../src/runtime/policy.js";
import type { MultimodalToolConfig, ToolContext } from "../../src/tools/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.doUnmock("../../src/model/multimodal.js");
  vi.resetModules();
});

async function createWorkspaceWithMedia(): Promise<{ root: string; mediaPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-analyze-"));
  tempRoots.push(root);
  const mediaPath = path.join(root, "clip.mp4");
  await writeFile(mediaPath, Buffer.from([0, 1, 2, 3]));
  return { root, mediaPath };
}

function createContext(workspaceRoot: string, multimodal?: MultimodalToolConfig): ToolContext {
  return {
    workspaceRoot,
    sessionId: "sess_test",
    runId: "run_test",
    toolCallId: "call_analyze_1",
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    skillRegistry: undefined,
    policy: createPolicyEngine({ workspaceRoot }),
    config: {
      toolTimeoutMs: 60_000,
      bashTimeoutMs: 120_000,
      maxBashOutputBytes: 64 * 1024,
      readMaxBytes: 256 * 1024,
      multimodal,
    },
  };
}

describe("analyzeMediaTool", () => {
  test("returns a MODEL_ERROR when no multimodal model is configured", async () => {
    const { root } = await createWorkspaceWithMedia();
    const { analyzeMediaTool } = await import("../../src/tools/analyze-media.js");

    const result = await analyzeMediaTool.execute({ path: "clip.mp4", instruction: "x" }, createContext(root));

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "MODEL_ERROR" });
    expect(result.content).toMatch(/not configured/u);
  });

  test("delegates to callOmni and surfaces text + parsed json", async () => {
    const { root, mediaPath } = await createWorkspaceWithMedia();
    const calls: unknown[] = [];
    vi.doMock("../../src/model/multimodal.js", () => ({
      callOmni: async (params: unknown) => {
        calls.push(params);
        return {
          text: "{\"events\":[]}",
          json: { events: [] },
          kind: "video",
          model: "qwen3.5-omni-plus",
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    }));
    const { analyzeMediaTool } = await import("../../src/tools/analyze-media.js");

    const multimodal: MultimodalToolConfig = {
      provider: "openai-compatible",
      model: "qwen3.5-omni-plus",
      baseURL: "https://example.com/v1",
      apiKey: "k",
    };
    const result = await analyzeMediaTool.execute(
      { path: "clip.mp4", instruction: "List events", want_json: true },
      createContext(root, multimodal),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toBe("{\"events\":[]}");
    expect(result.meta).toMatchObject({
      path: mediaPath,
      kind: "video",
      model: "qwen3.5-omni-plus",
      json: { events: [] },
    });
    expect(calls[0]).toMatchObject({
      config: multimodal,
      mediaPath,
      instruction: "List events",
      jsonMode: true,
    });
  });
});
