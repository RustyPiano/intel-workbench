import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  buildMediaContentPart,
  callOmni,
  detectMediaKind,
  mediaMimeType,
  type OmniClient,
  type OmniStreamChunk,
} from "../../src/model/multimodal.js";
import { base64EncodedLength, MAX_INLINE_BASE64_BYTES } from "../../src/model/media-limits.js";
import type { MultimodalToolConfig } from "../../src/tools/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createMediaFile(name: string, bytes = Buffer.from([0, 1, 2, 3])): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-mm-"));
  tempRoots.push(root);
  const filePath = path.join(root, name);
  await writeFile(filePath, bytes);
  return filePath;
}

const config: MultimodalToolConfig = {
  provider: "openai-compatible",
  model: "qwen3.5-omni-plus",
  baseURL: "https://example.com/v1",
  apiKey: "test-key",
};

const delta = (content: string): OmniStreamChunk => ({ choices: [{ delta: { content } }] });
const usageChunk = (prompt: number, completion: number): OmniStreamChunk => ({
  usage: { prompt_tokens: prompt, completion_tokens: completion },
});

/** Fake streaming client that records the request body and yields scripted chunks. */
function fakeClient(chunks: OmniStreamChunk[] | (() => Promise<never>)): {
  client: OmniClient;
  lastBody: () => Record<string, unknown> | undefined;
} {
  let captured: Record<string, unknown> | undefined;
  const client: OmniClient = {
    chat: {
      completions: {
        async create(body) {
          captured = body;
          if (typeof chunks === "function") {
            return chunks();
          }
          const list = chunks;
          async function* generate(): AsyncGenerator<OmniStreamChunk> {
            for (const chunk of list) {
              yield chunk;
            }
          }
          return generate();
        },
      },
    },
  };
  return { client, lastBody: () => captured };
}

describe("detectMediaKind", () => {
  test("classifies by extension", () => {
    expect(detectMediaKind("/tmp/clip.MP4")).toBe("video");
    expect(detectMediaKind("/tmp/talk.wav")).toBe("audio");
    expect(detectMediaKind("/tmp/call.3gpp")).toBe("audio");
    expect(detectMediaKind("/tmp/frame.png")).toBe("image");
  });

  test("throws on unsupported extension", () => {
    expect(() => detectMediaKind("/tmp/notes.txt")).toThrowError(/Unsupported media file extension/u);
  });
});

describe("mediaMimeType", () => {
  test("maps known extensions and falls back to octet-stream", () => {
    expect(mediaMimeType("a.mp4")).toBe("video/mp4");
    expect(mediaMimeType("a.mp3")).toBe("audio/mpeg");
    expect(mediaMimeType("a.unknownext")).toBe("application/octet-stream");
  });
});

describe("media limits", () => {
  test("calculates base64 encoded lengths", () => {
    expect(base64EncodedLength(0)).toBe(0);
    expect(base64EncodedLength(1)).toBe(4);
    expect(base64EncodedLength(3)).toBe(4);
    expect(base64EncodedLength(4)).toBe(8);
    expect(MAX_INLINE_BASE64_BYTES).toBe(10_000_000);
  });
});

describe("buildMediaContentPart", () => {
  test("uses the right part type per modality", () => {
    expect(buildMediaContentPart("video", "data:video/mp4;base64,AA", "mp4")).toEqual({
      type: "video_url",
      video_url: { url: "data:video/mp4;base64,AA" },
    });
    expect(buildMediaContentPart("audio", "data:;base64,AA", "mp3")).toEqual({
      type: "input_audio",
      input_audio: { data: "data:;base64,AA", format: "mp3" },
    });
    expect(buildMediaContentPart("image", "data:image/png;base64,AA", "png")).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AA" },
    });
  });
});

describe("callOmni", () => {
  test("builds a streaming multimodal request and accumulates the text deltas", async () => {
    const mediaPath = await createMediaFile("clip.mp4");
    const { client, lastBody } = fakeClient([delta("A door "), delta("opens at 00:05."), usageChunk(100, 20)]);

    const result = await callOmni({
      config,
      source: { type: "file", path: mediaPath },
      instruction: "Describe key events",
      client,
    });

    expect(result.text).toBe("A door opens at 00:05.");
    expect(result.kind).toBe("video");
    expect(result.model).toBe("qwen3.5-omni-plus");
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });

    const body = lastBody()!;
    expect(body.model).toBe("qwen3.5-omni-plus");
    expect(body.stream).toBe(true);
    expect(body.modalities).toEqual(["text"]);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.response_format).toBeUndefined();
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    const userContent = messages.at(-1)!.content as Array<Record<string, unknown>>;
    const videoPart = userContent[0] as { type: string; video_url: { url: string } };
    expect(videoPart.type).toBe("video_url");
    expect(videoPart.video_url.url.startsWith("data:;base64,")).toBe(true);
    expect(userContent[1]).toMatchObject({ type: "text", text: "Describe key events" });
  });

  test("builds a streaming multimodal request for video URLs", async () => {
    const { client, lastBody } = fakeClient([delta("ok")]);

    await callOmni({
      config,
      source: { type: "url", url: "https://example.com/clip.mp4", kind: "video" },
      instruction: "Describe",
      client,
    });

    const body = lastBody()!;
    expect(body).toMatchObject({
      modalities: ["text"],
      stream: true,
      stream_options: { include_usage: true },
    });
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages.at(-1)!.content[0]).toEqual({
      type: "video_url",
      video_url: { url: "https://example.com/clip.mp4" },
    });
  });

  test("builds a streaming multimodal request for image URLs", async () => {
    const { client, lastBody } = fakeClient([delta("ok")]);

    await callOmni({
      config,
      source: { type: "url", url: "https://example.com/frame.png", kind: "image" },
      instruction: "Describe",
      client,
    });

    const body = lastBody()!;
    expect(body).toMatchObject({
      modalities: ["text"],
      stream: true,
      stream_options: { include_usage: true },
    });
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages.at(-1)!.content[0]).toEqual({
      type: "image_url",
      image_url: { url: "https://example.com/frame.png" },
    });
  });

  test("builds a streaming multimodal request for audio URLs", async () => {
    const { client, lastBody } = fakeClient([delta("ok")]);

    await callOmni({
      config,
      source: { type: "url", url: "https://example.com/talk.wav", kind: "audio", format: "wav" },
      instruction: "Transcribe",
      client,
    });

    const body = lastBody()!;
    expect(body).toMatchObject({
      modalities: ["text"],
      stream: true,
      stream_options: { include_usage: true },
    });
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages.at(-1)!.content[0]).toEqual({
      type: "input_audio",
      input_audio: { data: "https://example.com/talk.wav", format: "wav" },
    });
  });

  test("encodes audio as a MIME-less data URL with a format field", async () => {
    const mediaPath = await createMediaFile("talk.mp3");
    const { client, lastBody } = fakeClient([delta("ok")]);

    await callOmni({ config, source: { type: "file", path: mediaPath }, instruction: "Transcribe", client });

    const messages = lastBody()!.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const audioPart = messages.at(-1)!.content[0] as { type: string; input_audio: { data: string; format: string } };
    expect(audioPart.type).toBe("input_audio");
    expect(audioPart.input_audio.format).toBe("mp3");
    expect(audioPart.input_audio.data.startsWith("data:;base64,")).toBe(true);
  });

  test("keeps image data URLs MIME-qualified", async () => {
    const mediaPath = await createMediaFile("frame.png");
    const { client, lastBody } = fakeClient([delta("ok")]);

    await callOmni({ config, source: { type: "file", path: mediaPath }, instruction: "Describe", client });

    const messages = lastBody()!.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const imagePart = messages.at(-1)!.content[0] as { type: string; image_url: { url: string } };
    expect(imagePart.type).toBe("image_url");
    expect(imagePart.image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("rejects inline media when the base64 payload would exceed DashScope's 10MB limit", async () => {
    const mediaPath = await createMediaFile("large.mp4", Buffer.alloc(8 * 1024 * 1024));
    const { client } = fakeClient([delta("should not be called")]);

    await expect(
      callOmni({ config, source: { type: "file", path: mediaPath }, instruction: "Describe", client }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGS",
    });
  });

  test("rejects inline media at the decimal 10MB base64 boundary", async () => {
    const mediaPath = await createMediaFile("boundary.mp4", Buffer.alloc(Math.ceil(MAX_INLINE_BASE64_BYTES / 4) * 3));
    const { client } = fakeClient([delta("should not be called")]);

    await expect(
      callOmni({ config, source: { type: "file", path: mediaPath }, instruction: "Describe", client }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGS",
      details: {
        encodedSizeBytes: MAX_INLINE_BASE64_BYTES,
      },
    });
  });

  test("jsonMode steers via instruction (no response_format) and parses fenced JSON", async () => {
    const mediaPath = await createMediaFile("talk.wav");
    const { client, lastBody } = fakeClient([delta("```json\n"), delta('{"events":[{"t":"00:03"}]}'), delta("\n```")]);

    const result = await callOmni({
      config,
      source: { type: "file", path: mediaPath },
      instruction: "Extract events as JSON",
      jsonMode: true,
      client,
    });

    expect(lastBody()!.response_format).toBeUndefined();
    const userText = ((lastBody()!.messages as Array<{ content: Array<{ text?: string }> }>).at(-1)!.content[1].text) ?? "";
    expect(userText).toMatch(/valid JSON/u);
    expect(result.json).toEqual({ events: [{ t: "00:03" }] });
  });

  test("jsonMode rejects unparseable model output so callers can retry or degrade", async () => {
    const mediaPath = await createMediaFile("talk.wav");
    const { client } = fakeClient([delta("not json")]);

    await expect(
      callOmni({
        config,
        source: { type: "file", path: mediaPath },
        instruction: "Extract events as JSON",
        jsonMode: true,
        client,
      }),
    ).rejects.toMatchObject({
      code: "MODEL_ERROR",
      retriable: true,
    });
  });

  test("throws when no model is configured", async () => {
    const mediaPath = await createMediaFile("clip.mp4");
    await expect(
      callOmni({
        config: { ...config, model: "" },
        source: { type: "file", path: mediaPath },
        instruction: "x",
        client: fakeClient([]).client,
      }),
    ).rejects.toMatchObject({ code: "MODEL_ERROR" });
  });

  test("throws when no api key and no injected client", async () => {
    const mediaPath = await createMediaFile("clip.mp4");
    await expect(
      callOmni({ config: { ...config, apiKey: undefined }, source: { type: "file", path: mediaPath }, instruction: "x" }),
    ).rejects.toMatchObject({
      code: "MODEL_ERROR",
    });
  });

  test("wraps upstream 429 as a retriable MODEL_ERROR", async () => {
    const mediaPath = await createMediaFile("clip.mp4");
    const { client } = fakeClient(async () => {
      const error = new Error("Too Many Requests") as Error & { status: number };
      error.status = 429;
      throw error;
    });

    await expect(callOmni({ config, source: { type: "file", path: mediaPath }, instruction: "x", client })).rejects.toMatchObject({
      code: "MODEL_ERROR",
      retriable: true,
    });
  });
});
