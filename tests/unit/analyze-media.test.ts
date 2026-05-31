import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createPolicyEngine } from "../../src/runtime/policy.js";
import { FileMutationQueue } from "../../src/tools/file-mutation-queue.js";
import { ToolRegistry } from "../../src/tools/index.js";
import type { MultimodalToolConfig, ToolContext, TosStorageConfig } from "../../src/tools/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.doUnmock("../../src/model/multimodal.js");
  vi.doUnmock("../../src/model/tos-storage.js");
  vi.resetModules();
});

async function createWorkspaceWithMedia(bytes = Buffer.from([0, 1, 2, 3])): Promise<{ root: string; mediaPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-analyze-"));
  tempRoots.push(root);
  const mediaPath = path.join(root, "clip.mp4");
  await writeFile(mediaPath, bytes);
  return { root, mediaPath };
}

function createContext(
  workspaceRoot: string,
  multimodal?: MultimodalToolConfig,
  fileMutationQueue?: FileMutationQueue,
  tos?: TosStorageConfig,
): ToolContext {
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
      tos,
    },
    fileMutationQueue,
  };
}

const tos: TosStorageConfig = {
  accessKeyId: "ak",
  accessKeySecret: "sk",
  bucket: "media-bucket",
  region: "cn-beijing",
  prefix: "mini-agent/uploads",
  signedUrlExpires: 3600,
};

describe("analyzeMediaTool", () => {
  test("returns a MODEL_ERROR when no multimodal model is configured", async () => {
    const { root } = await createWorkspaceWithMedia();
    const { analyzeMediaTool } = await import("../../src/tools/analyze-media.js");

    const result = await analyzeMediaTool.execute(
      { path: "clip.mp4", instruction: "x", out_path: "analysis/clip.json" },
      createContext(root),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "MODEL_ERROR" });
    expect(result.content).toMatch(/not configured/u);
  });

  test("returns INVALID_ARGS when a local media path does not exist", async () => {
    const { root } = await createWorkspaceWithMedia();
    let called = false;
    vi.doMock("../../src/model/multimodal.js", () => ({
      callOmni: async () => {
        called = true;
        return { text: "unexpected", kind: "video", model: "qwen3.5-omni-plus" };
      },
    }));
    const { analyzeMediaTool } = await import("../../src/tools/analyze-media.js");

    const result = await analyzeMediaTool.execute(
      { path: "missing.mp4", instruction: "Describe" },
      createContext(root, {
        provider: "openai-compatible",
        model: "qwen3.5-omni-plus",
        baseURL: "https://example.com/v1",
        apiKey: "k",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: "INVALID_ARGS",
      details: { category: "file" },
    });
    expect(result.content).toMatch(/Cannot read local media file/u);
    expect(called).toBe(false);
  });

  test("delegates to callOmni and writes text + parsed json to out_path", async () => {
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
      { path: "clip.mp4", instruction: "List events", out_path: "analysis/clip.json", want_json: true },
      createContext(root, multimodal, new FileMutationQueue()),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toMatch(/wrote result to .*clip\.json/u);
    expect(result.content).not.toContain("{\"events\":[]}");
    const written = JSON.parse(await readFile(path.join(root, "analysis/clip.json"), "utf8")) as unknown;
    expect(written).toEqual({
      source: { type: "file", path: mediaPath },
      kind: "video",
      model: "qwen3.5-omni-plus",
      text: "{\"events\":[]}",
      json: { events: [] },
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(result.meta).toMatchObject({
      source: { type: "file", path: mediaPath },
      kind: "video",
      model: "qwen3.5-omni-plus",
      outPath: path.join(root, "analysis/clip.json"),
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(result.meta).not.toHaveProperty("json");
    expect(result.artifacts).toEqual([
      {
        type: "file",
        path: "analysis/clip.json",
        description: "analyze_media result",
      },
    ]);
    expect(calls[0]).toMatchObject({
      config: multimodal,
      source: { type: "file", path: mediaPath },
      instruction: "List events",
      jsonMode: true,
    });
  });

  test("returns the model analysis inline when out_path is omitted", async () => {
    const { root } = await createWorkspaceWithMedia();
    vi.doMock("../../src/model/multimodal.js", () => ({
      callOmni: async () => ({
        text: "A short caption.",
        kind: "image",
        model: "qwen3.5-omni-plus",
        usage: { inputTokens: 3, outputTokens: 2 },
      }),
    }));
    const { analyzeMediaTool } = await import("../../src/tools/analyze-media.js");

    const result = await analyzeMediaTool.execute(
      { path: "clip.mp4", instruction: "Describe" },
      createContext(root, {
        provider: "openai-compatible",
        model: "qwen3.5-omni-plus",
        baseURL: "https://example.com/v1",
        apiKey: "k",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toBe("A short caption.");
    expect(result.artifacts).toBeUndefined();
    expect(result.meta).not.toHaveProperty("outPath");
    expect(result.meta).toMatchObject({ kind: "image", model: "qwen3.5-omni-plus" });
  });

  test("delegates URL media sources to callOmni and records source metadata", async () => {
    const { root } = await createWorkspaceWithMedia();
    const calls: unknown[] = [];
    vi.doMock("../../src/model/multimodal.js", () => ({
      callOmni: async (params: unknown) => {
        calls.push(params);
        return {
          text: "ok",
          kind: "audio",
          model: "qwen3.5-omni-plus",
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
      {
        url: "https://example.com/talk.wav",
        kind: "audio",
        format: "wav",
        instruction: "Transcribe",
        out_path: "analysis/audio.json",
      },
      createContext(root, multimodal),
    );

    expect(result.ok).toBe(true);
    expect(result.meta).toMatchObject({
      source: { type: "url", url: "https://example.com/talk.wav", kind: "audio", format: "wav" },
      kind: "audio",
      outPath: path.join(root, "analysis/audio.json"),
    });
    expect(calls[0]).toMatchObject({
      source: { type: "url", url: "https://example.com/talk.wav", kind: "audio", format: "wav" },
      instruction: "Transcribe",
    });
  });

  test("accepts documented 3GPP audio URL format", async () => {
    const { root } = await createWorkspaceWithMedia();
    const calls: unknown[] = [];
    vi.doMock("../../src/model/multimodal.js", () => ({
      callOmni: async (params: unknown) => {
        calls.push(params);
        return {
          text: "ok",
          kind: "audio",
          model: "qwen3.5-omni-plus",
        };
      },
    }));
    const { analyzeMediaTool } = await import("../../src/tools/analyze-media.js");

    const result = await analyzeMediaTool.execute(
      {
        url: "https://example.com/talk.3gpp",
        kind: "audio",
        format: "3gpp",
        instruction: "Transcribe",
        out_path: "analysis/audio-3gpp.json",
      },
      createContext(root, {
        provider: "openai-compatible",
        model: "qwen3.5-omni-plus",
        baseURL: "https://example.com/v1",
        apiKey: "k",
      }),
    );

    expect(result.ok).toBe(true);
    expect(calls[0]).toMatchObject({
      source: { type: "url", url: "https://example.com/talk.3gpp", kind: "audio", format: "3gpp" },
    });
  });

  test("rejects oversized local media with TOS setup guidance when TOS is not configured", async () => {
    const { root } = await createWorkspaceWithMedia(Buffer.alloc(8 * 1024 * 1024));
    let called = false;
    vi.doMock("../../src/model/multimodal.js", () => ({
      callOmni: async () => {
        called = true;
        return { text: "unexpected", kind: "video", model: "qwen3.5-omni-plus" };
      },
    }));
    const { analyzeMediaTool } = await import("../../src/tools/analyze-media.js");

    const result = await analyzeMediaTool.execute(
      { path: "clip.mp4", instruction: "Describe" },
      createContext(root, {
        provider: "openai-compatible",
        model: "qwen3.5-omni-plus",
        baseURL: "https://example.com/v1",
        apiKey: "k",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: "INVALID_ARGS",
      details: { missingTosConfig: true },
    });
    expect(result.content).toMatch(/MINI_AGENT_TOS_/u);
    expect(result.content).toMatch(/volcengine-media-setup/u);
    expect(called).toBe(false);
  });

  test("uploads oversized local media to TOS, sends the signed URL, and persists redacted metadata", async () => {
    const { root, mediaPath } = await createWorkspaceWithMedia(Buffer.alloc(8 * 1024 * 1024));
    const omniCalls: unknown[] = [];
    const publishCalls: unknown[] = [];
    vi.doMock("../../src/model/multimodal.js", () => ({
      callOmni: async (params: unknown) => {
        omniCalls.push(params);
        return {
          text: "large clip summary",
          kind: "video",
          model: "qwen3.5-omni-plus",
        };
      },
    }));
    vi.doMock("../../src/model/tos-storage.js", () => ({
      publishFileToTos: async (params: unknown) => {
        publishCalls.push(params);
        return {
          url: "https://signed.example/clip.mp4",
          bucket: "media-bucket",
          key: "mini-agent/uploads/run_test/call_analyze_1/clip.mp4",
          expiresSeconds: 3600,
          sizeBytes: 8 * 1024 * 1024,
        };
      },
      toPublishedMediaMetadata: (media: { bucket: string; key: string; expiresSeconds: number; sizeBytes: number }) => ({
        bucket: media.bucket,
        key: media.key,
        expiresSeconds: media.expiresSeconds,
        sizeBytes: media.sizeBytes,
      }),
    }));
    const { analyzeMediaTool } = await import("../../src/tools/analyze-media.js");

    const result = await analyzeMediaTool.execute(
      { path: "clip.mp4", instruction: "Describe", out_path: "analysis/large-clip.json" },
      createContext(
        root,
        {
          provider: "openai-compatible",
          model: "qwen3.5-omni-plus",
          baseURL: "https://example.com/v1",
          apiKey: "k",
        },
        new FileMutationQueue(),
        tos,
      ),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toMatch(/wrote result to .*large-clip\.json/u);
    expect(publishCalls[0]).toMatchObject({
      config: tos,
      filePath: mediaPath,
      runId: "run_test",
      toolCallId: "call_analyze_1",
      contentType: "video/mp4",
    });
    expect(omniCalls[0]).toMatchObject({
      source: { type: "url", url: "https://signed.example/clip.mp4", kind: "video" },
    });
    expect(result.meta).toMatchObject({
      source: { type: "url", url: "(redacted TOS signed URL)", kind: "video" },
      originalSource: { type: "file", path: mediaPath },
      publishedMedia: {
        bucket: "media-bucket",
        key: "mini-agent/uploads/run_test/call_analyze_1/clip.mp4",
        expiresSeconds: 3600,
        sizeBytes: 8 * 1024 * 1024,
      },
    });
    expect(JSON.stringify(result.meta)).not.toContain("https://signed.example");
    const meta = result.meta as unknown as Record<string, unknown>;
    expect(meta.publishedMedia).not.toHaveProperty("url");
    const writtenText = await readFile(path.join(root, "analysis/large-clip.json"), "utf8");
    expect(writtenText).not.toContain("https://signed.example");
    const written = JSON.parse(writtenText) as Record<string, unknown>;
    expect(written).toMatchObject({
      source: { type: "url", url: "(redacted TOS signed URL)", kind: "video" },
      originalSource: { type: "file", path: mediaPath },
      publishedMedia: {
        bucket: "media-bucket",
        key: "mini-agent/uploads/run_test/call_analyze_1/clip.mp4",
        expiresSeconds: 3600,
        sizeBytes: 8 * 1024 * 1024,
      },
    });
    expect(written.publishedMedia).not.toHaveProperty("url");
  });

  test("accepts OpenAI strict-mode null optional fields through ToolRegistry", async () => {
    const { root, mediaPath } = await createWorkspaceWithMedia();
    const calls: unknown[] = [];
    vi.doMock("../../src/model/multimodal.js", () => ({
      callOmni: async (params: unknown) => {
        calls.push(params);
        return {
          text: "ok",
          kind: "video",
          model: "qwen3.5-omni-plus",
        };
      },
    }));
    const { analyzeMediaTool } = await import("../../src/tools/analyze-media.js");
    const registry = new ToolRegistry([analyzeMediaTool]);
    const multimodal: MultimodalToolConfig = {
      provider: "openai-compatible",
      model: "qwen3.5-omni-plus",
      baseURL: "https://example.com/v1",
      apiKey: "k",
    };

    const pathResult = await registry.execute(
      {
        id: "call_path",
        name: "analyze_media",
        arguments: {
          path: "clip.mp4",
          url: null,
          kind: null,
          format: null,
          instruction: "Summarize",
          out_path: "analysis/path.json",
          want_json: null,
        },
      },
      createContext(root, multimodal),
    );
    const urlResult = await registry.execute(
      {
        id: "call_url",
        name: "analyze_media",
        arguments: {
          path: null,
          url: "https://example.com/clip.mp4",
          kind: "video",
          format: null,
          instruction: "Summarize",
          out_path: "analysis/url.json",
          want_json: null,
        },
      },
      createContext(root, multimodal),
    );
    const pathWithIgnoredFormatResult = await registry.execute(
      {
        id: "call_path_ignored_format",
        name: "analyze_media",
        arguments: {
          path: "clip.mp4",
          url: null,
          kind: null,
          format: "exe",
          instruction: "Summarize",
          out_path: "analysis/path-format.json",
          want_json: null,
        },
      },
      createContext(root, multimodal),
    );

    expect(pathResult.ok).toBe(true);
    expect(urlResult.ok).toBe(true);
    expect(pathWithIgnoredFormatResult.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ source: { type: "file", path: mediaPath }, jsonMode: false });
    expect(calls[1]).toMatchObject({ source: { type: "url", url: "https://example.com/clip.mp4", kind: "video" } });
    expect(calls[2]).toMatchObject({ source: { type: "file", path: mediaPath }, jsonMode: false });
  });

  test.each([
    [
      "both path and url",
      {
        path: "clip.mp4",
        url: "https://example.com/clip.mp4",
        kind: "video",
        instruction: "x",
        out_path: "analysis/invalid.json",
      },
    ],
    ["neither path nor url", { instruction: "x", out_path: "analysis/invalid.json" }],
    ["URL without kind", { url: "https://example.com/clip.mp4", instruction: "x", out_path: "analysis/invalid.json" }],
    [
      "audio URL without format",
      { url: "https://example.com/talk.wav", kind: "audio", instruction: "x", out_path: "analysis/invalid.json" },
    ],
    [
      "unsupported kind",
      { url: "https://example.com/clip.mp4", kind: "document", instruction: "x", out_path: "analysis/invalid.json" },
    ],
    [
      "unsupported audio format",
      {
        url: "https://example.com/talk.exe",
        kind: "audio",
        format: "exe",
        instruction: "x",
        out_path: "analysis/invalid.json",
      },
    ],
  ])("rejects invalid source arguments: %s", async (_name, args) => {
    const { root } = await createWorkspaceWithMedia();
    let called = false;
    vi.doMock("../../src/model/multimodal.js", () => ({
      callOmni: async () => {
        called = true;
        return { text: "unexpected", kind: "video", model: "qwen3.5-omni-plus" };
      },
    }));
    const { analyzeMediaTool } = await import("../../src/tools/analyze-media.js");
    const registry = new ToolRegistry([analyzeMediaTool]);

    const result = await registry.execute(
      { id: "call_invalid", name: "analyze_media", arguments: args },
      createContext(root, {
        provider: "openai-compatible",
        model: "qwen3.5-omni-plus",
        baseURL: "https://example.com/v1",
        apiKey: "k",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "INVALID_ARGS" });
    expect(called).toBe(false);
  });
});
