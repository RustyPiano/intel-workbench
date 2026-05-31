import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createPolicyEngine, type PolicyEngine } from "../../src/runtime/policy.js";
import { FileMutationQueue } from "../../src/tools/file-mutation-queue.js";
import { ToolRegistry } from "../../src/tools/index.js";
import type { AsrToolConfig, ToolContext, TosStorageConfig } from "../../src/tools/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.doUnmock("../../src/model/asr.js");
  vi.doUnmock("../../src/model/tos-storage.js");
  vi.resetModules();
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-analyze-audio-"));
  tempRoots.push(root);
  return root;
}

async function createAudioFile(root: string, name = "talk.wav"): Promise<string> {
  const filePath = path.join(root, name);
  await writeFile(filePath, Buffer.from([0, 1, 2, 3]));
  return filePath;
}

function createContext(
  workspaceRoot: string,
  asr?: AsrToolConfig,
  fileMutationQueue?: FileMutationQueue,
  readOnly = false,
  policy?: PolicyEngine,
  tos?: TosStorageConfig,
): ToolContext {
  return {
    workspaceRoot,
    sessionId: "sess_test",
    runId: "run_test",
    toolCallId: "call_analyze_audio_1",
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    skillRegistry: undefined,
    policy: policy ?? createPolicyEngine({ workspaceRoot, readOnly }),
    config: {
      toolTimeoutMs: 60_000,
      bashTimeoutMs: 120_000,
      maxBashOutputBytes: 64 * 1024,
      readMaxBytes: 256 * 1024,
      asr,
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

describe("analyzeAudioTool", () => {
  test("returns transcript and utterances inline when out_path is omitted", async () => {
    const root = await createWorkspace();
    // This is the first test in the file; the static ToolRegistry import has
    // already loaded asr.js via the tool barrel, so reset before mocking so the
    // doMock below actually takes effect on the dynamic import.
    vi.resetModules();
    vi.doMock("../../src/model/asr.js", () => ({
      callAsr: async () => ({
        text: "Hello there.",
        durationMs: 1000,
        utterances: [{ startMs: 0, endMs: 1000, text: "Hello there.", speaker: "S1", emotion: "neutral" }],
        raw: { huge: "provider payload that should not be inlined" },
      }),
    }));
    const { analyzeAudioTool } = await import("../../src/tools/analyze-audio.js");
    const registry = new ToolRegistry([analyzeAudioTool]);

    const result = await registry.execute(
      {
        id: "call_inline_audio",
        name: "analyze_audio",
        arguments: {
          url: "https://example.com/talk.wav",
          format: "wav",
        },
      },
      createContext(root, {
        baseURL: "https://openspeech.bytedance.com",
        resourceId: "volc.seedasr.auc",
        apiKey: "k",
      }),
    );

    expect(result.ok).toBe(true);
    const inline = JSON.parse(result.content) as Record<string, unknown>;
    expect(inline).toEqual({
      provider: "doubao-asr",
      text: "Hello there.",
      durationMs: 1000,
      utterances: [{ startMs: 0, endMs: 1000, text: "Hello there.", speaker: "S1", emotion: "neutral" }],
    });
    expect(result.content).not.toContain("provider payload");
    expect(result.meta).toEqual({ durationMs: 1000, utteranceCount: 1, speakerCount: 1 });
    expect(result.artifacts).toBeUndefined();
  });

  test("rejects non-JSON advanced with INVALID_ARGS", async () => {
    const root = await createWorkspace();
    const { analyzeAudioTool } = await import("../../src/tools/analyze-audio.js");

    const result = await analyzeAudioTool.execute(
      {
        url: "https://example.com/talk.wav",
        format: "wav",
        out_path: "analysis/audio.json",
        speaker: true,
        emotion: true,
        advanced: "{not json",
      },
      createContext(root, {
        baseURL: "https://openspeech.bytedance.com",
        resourceId: "volc.seedasr.auc",
        apiKey: "k",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "INVALID_ARGS" });
    expect(result.content).toMatch(/advanced/u);
  });

  test("returns a MODEL_ERROR when ASR is not configured", async () => {
    const root = await createWorkspace();
    const { analyzeAudioTool } = await import("../../src/tools/analyze-audio.js");

    const result = await analyzeAudioTool.execute(
      {
        url: "https://example.com/talk.wav",
        format: "wav",
        out_path: "analysis/audio.json",
        speaker: true,
        emotion: true,
      },
      createContext(root),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "MODEL_ERROR" });
    expect(result.content).toMatch(/MINI_AGENT_ASR_\*/u);
  });

  test("returns a MODEL_ERROR when local audio is provided without TOS config", async () => {
    const root = await createWorkspace();
    await createAudioFile(root);
    const { analyzeAudioTool } = await import("../../src/tools/analyze-audio.js");

    const result = await analyzeAudioTool.execute(
      {
        path: "talk.wav",
        out_path: "analysis/audio.json",
        speaker: true,
        emotion: true,
      },
      createContext(root, {
        baseURL: "https://openspeech.bytedance.com",
        resourceId: "volc.seedasr.auc",
        apiKey: "k",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: "MODEL_ERROR",
      details: { missingTosConfig: true },
    });
    expect(result.content).toMatch(/Local audio/u);
    expect(result.content).toMatch(/MINI_AGENT_TOS_/u);
    expect(result.content).toMatch(/volcengine-media-setup/u);
  });

  test("uploads local audio to TOS before calling ASR", async () => {
    const root = await createWorkspace();
    const mediaPath = await createAudioFile(root);
    const asrCalls: unknown[] = [];
    const publishCalls: unknown[] = [];
    vi.doMock("../../src/model/asr.js", () => ({
      callAsr: async (params: unknown) => {
        asrCalls.push(params);
        return {
          text: "Local transcript.",
          durationMs: 1000,
          utterances: [{ startMs: 0, endMs: 1000, text: "Local transcript.", speaker: "S1" }],
          raw: { ok: true },
        };
      },
    }));
    vi.doMock("../../src/model/tos-storage.js", () => ({
      publishFileToTos: async (params: unknown) => {
        publishCalls.push(params);
        return {
          url: "https://signed.example/talk.wav",
          bucket: "media-bucket",
          key: "mini-agent/uploads/run_test/call_analyze_audio_1/talk.wav",
          expiresSeconds: 3600,
          sizeBytes: 4,
        };
      },
      toPublishedMediaMetadata: (media: { bucket: string; key: string; expiresSeconds: number; sizeBytes: number }) => ({
        bucket: media.bucket,
        key: media.key,
        expiresSeconds: media.expiresSeconds,
        sizeBytes: media.sizeBytes,
      }),
    }));
    const { analyzeAudioTool } = await import("../../src/tools/analyze-audio.js");

    const result = await analyzeAudioTool.execute(
      {
        path: "talk.wav",
        out_path: "analysis/local-audio.json",
        speaker: true,
        emotion: false,
      },
      createContext(
        root,
        {
          baseURL: "https://openspeech.bytedance.com",
          resourceId: "volc.seedasr.auc",
          apiKey: "k",
        },
        new FileMutationQueue(),
        false,
        undefined,
        tos,
      ),
    );

    expect(result.ok).toBe(true);
    expect(publishCalls[0]).toMatchObject({
      config: tos,
      filePath: mediaPath,
      runId: "run_test",
      toolCallId: "call_analyze_audio_1",
      contentType: "audio/wav",
    });
    expect(asrCalls[0]).toMatchObject({
      url: "https://signed.example/talk.wav",
      format: "wav",
      enableSpeakerInfo: true,
      enableEmotionDetection: false,
    });
    expect(result.meta).toMatchObject({
      outPath: path.join(root, "analysis/local-audio.json"),
      source: { type: "file", path: mediaPath },
      publishedMedia: {
        bucket: "media-bucket",
        key: "mini-agent/uploads/run_test/call_analyze_audio_1/talk.wav",
        expiresSeconds: 3600,
        sizeBytes: 4,
      },
    });
    expect(JSON.stringify(result.meta)).not.toContain("https://signed.example");
    const meta = result.meta as unknown as Record<string, unknown>;
    expect(meta.publishedMedia).not.toHaveProperty("url");
    const written = JSON.parse(await readFile(path.join(root, "analysis/local-audio.json"), "utf8")) as Record<string, unknown>;
    expect(written.source).toEqual({ type: "file", path: mediaPath });
    expect(JSON.stringify(written)).not.toContain("https://signed.example");
    expect(written.publishedMedia).toMatchObject({
      bucket: "media-bucket",
      key: "mini-agent/uploads/run_test/call_analyze_audio_1/talk.wav",
      expiresSeconds: 3600,
      sizeBytes: 4,
    });
    expect(written.publishedMedia).not.toHaveProperty("url");
  });

  test("delegates to callAsr and writes normalized ASR envelope to out_path", async () => {
    const root = await createWorkspace();
    const calls: unknown[] = [];
    vi.doMock("../../src/model/asr.js", () => ({
      callAsr: async (params: unknown) => {
        calls.push(params);
        return {
          text: "Hello there. General Kenobi.",
          durationMs: 2400,
          utterances: [
            { startMs: 0, endMs: 1000, text: "Hello there.", speaker: "S1", emotion: "neutral" },
            { startMs: 1100, endMs: 2400, text: "General Kenobi.", speaker: "S2", emotion: "happy" },
          ],
          raw: { result: { text: "Hello there. General Kenobi." } },
          degradedNote: "best effort",
        };
      },
    }));
    const { analyzeAudioTool } = await import("../../src/tools/analyze-audio.js");
    const asr: AsrToolConfig = {
      baseURL: "https://openspeech.bytedance.com",
      resourceId: "volc.seedasr.auc",
      apiKey: "k",
    };

    const result = await analyzeAudioTool.execute(
      {
        url: "https://example.com/talk.wav",
        format: "wav",
        out_path: "analysis/audio.json",
        language: "en-US",
        speaker: false,
        emotion: true,
        hotwords: ["Kenobi"],
        advanced: "{\"enable_itn\":false}",
      },
      createContext(root, asr, new FileMutationQueue()),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toMatch(/2 utterances/u);
    expect(result.content).toMatch(/2400ms/u);
    expect(result.content).toMatch(/2 speakers/u);
    expect(result.content).toMatch(/best effort/u);
    expect(result.content).toMatch(/analysis\/audio\.json/u);
    const written = JSON.parse(await readFile(path.join(root, "analysis/audio.json"), "utf8")) as unknown;
    expect(written).toEqual({
      provider: "doubao-asr",
      resourceId: "volc.seedasr.auc",
      language: "en-US",
      text: "Hello there. General Kenobi.",
      durationMs: 2400,
      utterances: [
        { startMs: 0, endMs: 1000, text: "Hello there.", speaker: "S1", emotion: "neutral" },
        { startMs: 1100, endMs: 2400, text: "General Kenobi.", speaker: "S2", emotion: "happy" },
      ],
      raw: { result: { text: "Hello there. General Kenobi." } },
      degradedNote: "best effort",
    });
    expect(result.meta).toEqual({
      outPath: path.join(root, "analysis/audio.json"),
      durationMs: 2400,
      utteranceCount: 2,
      speakerCount: 2,
    });
    expect(result.artifacts).toEqual([
      {
        type: "file",
        path: "analysis/audio.json",
        description: "analyze_audio result",
      },
    ]);
    expect(calls[0]).toMatchObject({
      config: asr,
      url: "https://example.com/talk.wav",
      format: "wav",
      language: "en-US",
      hotwords: ["Kenobi"],
      enableSpeakerInfo: false,
      enableEmotionDetection: true,
      advanced: { enable_itn: false },
    });
    expect(calls[0]).toHaveProperty("signal");
  });

  test("reports persistence failures without losing the ASR preview", async () => {
    const root = await createWorkspace();
    vi.doMock("../../src/model/asr.js", () => ({
      callAsr: async () => ({
        text: "The transcript was produced before the write failed.",
        durationMs: 1000,
        utterances: [{ startMs: 0, endMs: 1000, text: "The transcript was produced before the write failed." }],
        raw: { ok: true },
      }),
    }));
    const { analyzeAudioTool } = await import("../../src/tools/analyze-audio.js");
    // Resolve the policy from the same (reset) module graph as the dynamically
    // imported tool so the PATH_NOT_ALLOWED RuntimeError crosses the persist
    // boundary as the same class (instanceof is realm-sensitive under
    // vi.resetModules + dynamic import).
    const { createPolicyEngine: freshCreatePolicyEngine } = await import("../../src/runtime/policy.js");
    const readOnlyPolicy = freshCreatePolicyEngine({ workspaceRoot: root, readOnly: true });

    const result = await analyzeAudioTool.execute(
      {
        url: "https://example.com/talk.wav",
        format: "wav",
        out_path: "analysis/audio.json",
        speaker: true,
        emotion: true,
      },
      createContext(
        root,
        {
          baseURL: "https://openspeech.bytedance.com",
          resourceId: "volc.seedasr.auc",
          apiKey: "k",
        },
        undefined,
        true,
        readOnlyPolicy,
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(result.content).toMatch(/not writable/u);
    expect(result.content).toMatch(/ASR output preview/u);
    expect(result.content).toMatch(/transcript was produced/u);
  });

  test("defaults speaker and emotion to true through ToolRegistry", async () => {
    const root = await createWorkspace();
    const calls: unknown[] = [];
    vi.doMock("../../src/model/asr.js", () => ({
      callAsr: async (params: unknown) => {
        calls.push(params);
        return {
          text: "",
          utterances: [],
          raw: {},
        };
      },
    }));
    const { analyzeAudioTool } = await import("../../src/tools/analyze-audio.js");
    const registry = new ToolRegistry([analyzeAudioTool]);

    const result = await registry.execute(
      {
        id: "call_audio_defaults",
        name: "analyze_audio",
        arguments: {
          url: "https://example.com/talk.wav",
          format: "wav",
          out_path: "analysis/defaults.json",
        },
      },
      createContext(root, {
        baseURL: "https://openspeech.bytedance.com",
        resourceId: "volc.seedasr.auc",
        apiKey: "k",
      }),
    );

    expect(result.ok).toBe(true);
    expect(calls[0]).toMatchObject({
      enableSpeakerInfo: true,
      enableEmotionDetection: true,
    });
  });
});
