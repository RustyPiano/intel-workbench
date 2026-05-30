import { describe, expect, test, vi } from "vitest";

import { callAsr } from "../../src/model/asr.js";
import { RuntimeError } from "../../src/runtime/errors.js";

const config = {
  baseURL: "https://openspeech.example.com",
  resourceId: "volc.seedasr.auc",
  apiKey: "new-console-key",
  appId: "app-1",
  timeoutMs: 10_000,
};

function jsonResponse(body: unknown, statusCode: string, init: { ok?: boolean; status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", "X-Api-Status-Code": statusCode },
  });
}

function fakeFetch(responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const response = responses.shift();
    if (!response) {
      throw new Error("unexpected fetch call");
    }
    return response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function parseCallBody(call: { init: RequestInit }): Record<string, unknown> {
  expect(typeof call.init.body).toBe("string");
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

describe("callAsr", () => {
  test("submits with new-console auth, polls with the same request id, and normalizes the result", async () => {
    const raw = {
      audio_info: { duration: 3210 },
      result: {
        text: "hello world",
        utterances: [
          {
            start_time: 0,
            end_time: 1200,
            text: "hello",
            additions: {
              speaker: "speaker-1",
              emotion: "happy",
              speech_rate: 1.25,
              volume: "0.8",
              gender: "female",
            },
          },
          { start_ms: "1200", end_ms: "3210", text: "world", speaker_id: "speaker-2" },
        ],
      },
    };
    const { fetch, calls } = fakeFetch([
      jsonResponse({ task: "accepted" }, "20000000"),
      jsonResponse({ progress: 50 }, "20000001"),
      jsonResponse(raw, "20000000"),
    ]);

    const result = await callAsr({
      config,
      url: "https://example.com/talk.wav",
      format: "wav",
      user: "user-1",
      language: "zh-CN",
      hotwords: ["Mini Agent", "Doubao"],
      enableSpeakerInfo: true,
      enableEmotionDetection: false,
      audio: { codec: "pcm" },
      advanced: { extra_flag: true },
      fetch,
      pollDelaysMs: [1],
    });

    expect(result).toEqual({
      text: "hello world",
      durationMs: 3210,
      raw,
      utterances: [
        {
          startMs: 0,
          endMs: 1200,
          text: "hello",
          speaker: "speaker-1",
          emotion: "happy",
          speechRate: 1.25,
          volume: 0.8,
          gender: "female",
        },
        { startMs: 1200, endMs: 3210, text: "world", speaker: "speaker-2" },
      ],
    });

    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe("https://openspeech.example.com/api/v3/auc/bigmodel/submit");
    expect(calls[1]!.url).toBe("https://openspeech.example.com/api/v3/auc/bigmodel/query");
    expect(calls[2]!.url).toBe("https://openspeech.example.com/api/v3/auc/bigmodel/query");
    for (const call of calls) {
      expect(call.init.method).toBe("POST");
      const headers = call.init.headers as Record<string, string>;
      expect(headers["X-Api-Key"]).toBe("new-console-key");
      expect(headers["X-Api-Resource-Id"]).toBe("volc.seedasr.auc");
      expect(headers["X-Api-Sequence"]).toBe("-1");
      expect(headers["X-Api-Request-Id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
      );
    }
    expect((calls[0]!.init.headers as Record<string, string>)["X-Api-Request-Id"]).toBe(
      (calls[2]!.init.headers as Record<string, string>)["X-Api-Request-Id"],
    );

    expect(parseCallBody(calls[0]!)).toEqual({
      user: "user-1",
      audio: { url: "https://example.com/talk.wav", format: "wav", codec: "pcm" },
      request: {
        model_name: "bigmodel",
        show_utterances: true,
        enable_punc: true,
        enable_itn: true,
        enable_speaker_info: true,
        enable_emotion_detection: false,
        language: "zh-CN",
        context: { hotwords: ["Mini Agent", "Doubao"] },
        extra_flag: true,
      },
    });
    expect(parseCallBody(calls[1]!)).toEqual({});
  });

  test("uses old-console auth headers when app key and access key are configured", async () => {
    const { fetch, calls } = fakeFetch([
      jsonResponse({}, "20000000"),
      jsonResponse({ result: { text: "ok", utterances: [] } }, "20000000"),
    ]);

    await callAsr({
      config: {
        baseURL: "https://openspeech.example.com/",
        resourceId: "volc.seedasr.auc",
        appKey: "app-key",
        accessKey: "access-key",
      },
      url: "https://example.com/talk.mp3",
      format: "mp3",
      fetch,
    });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBeUndefined();
    expect(headers["X-Api-App-Key"]).toBe("app-key");
    expect(headers["X-Api-Access-Key"]).toBe("access-key");
  });

  test("returns a degraded silent result for status 20000003", async () => {
    const raw = { result: { text: "ignored" } };
    const { fetch } = fakeFetch([jsonResponse({}, "20000000"), jsonResponse(raw, "20000003")]);

    await expect(
      callAsr({
        config,
        url: "https://example.com/silence.wav",
        format: "wav",
        fetch,
      }),
    ).resolves.toEqual({
      text: "",
      utterances: [],
      raw,
      degradedNote: "Doubao ASR reported silent audio; returning an empty transcript.",
    });
  });

  test("maps documented invalid argument and retriable status codes to RuntimeError", async () => {
    const invalid = fakeFetch([jsonResponse({}, "20000000"), jsonResponse({}, "45000001")]);
    await expect(callAsr({ config, url: "https://example.com/a.wav", format: "wav", fetch: invalid.fetch })).rejects.toMatchObject({
      code: "INVALID_ARGS",
      retriable: false,
      details: { category: "asr", statusCode: "45000001" },
    });

    const tooLarge = fakeFetch([jsonResponse({}, "20000000"), jsonResponse({}, "45000132")]);
    await expect(callAsr({ config, url: "https://example.com/a.wav", format: "wav", fetch: tooLarge.fetch })).rejects.toThrow(
      /smaller file/u,
    );

    const retriable = fakeFetch([jsonResponse({}, "20000000"), jsonResponse({}, "55000031")]);
    await expect(callAsr({ config, url: "https://example.com/a.wav", format: "wav", fetch: retriable.fetch })).rejects.toMatchObject({
      code: "MODEL_ERROR",
      retriable: true,
      details: { category: "asr", statusCode: "55000031" },
    });
  });

  test("wraps network errors as retriable ASR model errors", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof globalThis.fetch;

    await expect(callAsr({ config, url: "https://example.com/a.wav", format: "wav", fetch })).rejects.toMatchObject({
      code: "MODEL_ERROR",
      message: "fetch failed",
      retriable: true,
      details: { category: "asr" },
    });
  });

  test("honors abort signals while polling", async () => {
    const controller = new AbortController();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, "20000000"))
      .mockImplementationOnce(async () => {
        controller.abort();
        return jsonResponse({}, "20000001");
      }) as unknown as typeof globalThis.fetch;

    await expect(
      callAsr({
        config,
        url: "https://example.com/a.wav",
        format: "wav",
        fetch,
        signal: controller.signal,
        pollDelaysMs: [10_000],
      }),
    ).rejects.toMatchObject({
      code: "MODEL_ERROR",
      retriable: true,
      details: { category: "asr" },
    });
  });
});
