import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { RuntimeError } from "../runtime/errors.js";

export interface AsrUtterance {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
  emotion?: string;
  speechRate?: number;
  volume?: number;
  gender?: string;
}

export interface AsrResult {
  text: string;
  utterances: AsrUtterance[];
  durationMs?: number;
  raw: unknown;
  degradedNote?: string;
}

export interface AsrClientConfig {
  baseURL: string;
  resourceId: string;
  appId?: string;
  apiKey?: string;
  appKey?: string;
  accessKey?: string;
  timeoutMs?: number;
}

export interface CallAsrParams {
  config: AsrClientConfig;
  url: string;
  format: string;
  user?: string;
  language?: string;
  hotwords?: string[];
  enableSpeakerInfo?: boolean;
  enableEmotionDetection?: boolean;
  audio?: Record<string, unknown>;
  advanced?: Record<string, unknown>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  pollDelaysMs?: number[];
}

const SUBMIT_PATH = "/api/v3/auc/bigmodel/submit";
const QUERY_PATH = "/api/v3/auc/bigmodel/query";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_DELAYS_MS = [2_000, 3_000, 5_000, 10_000];
const PROCESSING_CODES = new Set(["20000001", "20000002"]);

const INVALID_ARG_STATUS = new Set(["45000001", "45000002", "45000151"]);
const RETRIABLE_STATUS = new Set(["45000131", "55000031"]);

type JsonObject = Record<string, unknown>;

export async function callAsr(params: CallAsrParams): Promise<AsrResult> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const timeoutMs = params.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = params.fetch ?? globalThis.fetch;
  if (!fetchFn) {
    throw new RuntimeError({
      code: "MODEL_ERROR",
      message: "ASR fetch is unavailable in this runtime.",
      retriable: false,
      details: { category: "asr" },
    });
  }

  const headers = buildHeaders(params.config, requestId);
  const submitBody = buildSubmitBody(params);

  try {
    await postJson(fetchFn, buildURL(params.config.baseURL, SUBMIT_PATH), headers, submitBody, params.signal);

    for (let attempt = 0; ; attempt += 1) {
      assertWithinTimeout(startedAt, timeoutMs);
      const response = await postJson(fetchFn, buildURL(params.config.baseURL, QUERY_PATH), headers, {}, params.signal);
      const statusCode = response.headers.get("X-Api-Status-Code") ?? response.headers.get("x-api-status-code");

      if (statusCode === "20000000") {
        const raw = await parseResponseJson(response);
        return normalizeAsrResult(raw);
      }

      if (statusCode === "20000003") {
        const raw = await parseResponseJson(response);
        return {
          text: "",
          utterances: [],
          raw,
          degradedNote: "Doubao ASR reported silent audio; returning an empty transcript.",
        };
      }

      if (statusCode && PROCESSING_CODES.has(statusCode)) {
        await waitBeforeNextPoll(params.pollDelaysMs ?? DEFAULT_POLL_DELAYS_MS, attempt, startedAt, timeoutMs, params.signal);
        continue;
      }

      throw asrStatusError(statusCode, response);
    }
  } catch (error) {
    if (error instanceof RuntimeError) {
      throw error;
    }
    throw toAsrNetworkError(error);
  }
}

function buildHeaders(config: AsrClientConfig, requestId: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Resource-Id": config.resourceId,
    "X-Api-Request-Id": requestId,
    "X-Api-Sequence": "-1",
  };

  if (config.apiKey) {
    headers["X-Api-Key"] = config.apiKey;
  } else if (config.appKey && config.accessKey) {
    headers["X-Api-App-Key"] = config.appKey;
    headers["X-Api-Access-Key"] = config.accessKey;
  } else {
    throw new RuntimeError({
      code: "MODEL_ERROR",
      message: "No ASR credentials configured. Set MINI_AGENT_ASR_API_KEY or MINI_AGENT_ASR_APP_KEY + MINI_AGENT_ASR_ACCESS_KEY.",
      retriable: false,
      details: { category: "asr" },
    });
  }

  return headers;
}

function buildSubmitBody(params: CallAsrParams): JsonObject {
  const request: JsonObject = {
    model_name: "bigmodel",
    show_utterances: true,
    enable_punc: true,
    enable_itn: true,
    enable_speaker_info: params.enableSpeakerInfo ?? true,
    enable_emotion_detection: params.enableEmotionDetection ?? true,
  };
  if (params.language) {
    request.language = params.language;
  }
  if (params.hotwords?.length) {
    request.context = { hotwords: params.hotwords };
  }
  Object.assign(request, params.advanced ?? {});

  return {
    user: params.user ?? params.config.appId ?? "mini-agent",
    audio: {
      url: params.url,
      format: params.format,
      ...(params.audio ?? {}),
    },
    request,
  };
}

async function postJson(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: JsonObject,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetchFn(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new RuntimeError({
      code: "MODEL_ERROR",
      message: `Doubao ASR HTTP request failed with status ${response.status}.`,
      retriable: response.status === 429 || response.status >= 500,
      details: { category: "asr", httpStatus: response.status },
    });
  }

  return response;
}

function buildURL(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/u, "")}${path}`;
}

async function waitBeforeNextPoll(
  delaysMs: number[],
  attempt: number,
  startedAt: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const delayMs = delaysMs[Math.min(attempt, delaysMs.length - 1)] ?? 10_000;
  assertWithinTimeout(startedAt, timeoutMs, delayMs);
  await sleep(delayMs, undefined, { signal });
}

function assertWithinTimeout(startedAt: number, timeoutMs: number, nextDelayMs = 0): void {
  if (Date.now() - startedAt + nextDelayMs > timeoutMs) {
    throw new RuntimeError({
      code: "MODEL_ERROR",
      message: `Doubao ASR request timed out after ${timeoutMs}ms.`,
      retriable: true,
      details: { category: "asr", timeoutMs },
    });
  }
}

async function parseResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function normalizeAsrResult(raw: unknown): AsrResult {
  const root = asObject(raw) ?? {};
  const result = asObject(root.result) ?? root;
  const audioInfo = asObject(root.audio_info) ?? asObject(result.audio_info);
  const utterancesRaw = Array.isArray(result.utterances) ? result.utterances : [];

  return {
    text: asString(result.text) ?? "",
    utterances: utterancesRaw.map(normalizeUtterance).filter((utterance): utterance is AsrUtterance => utterance !== undefined),
    durationMs: asNumber(audioInfo?.duration),
    raw,
  };
}

function normalizeUtterance(value: unknown): AsrUtterance | undefined {
  const utterance = asObject(value);
  if (!utterance) {
    return undefined;
  }

  const startMs = firstNumber(utterance, ["startMs", "start_ms", "start_time", "start"]);
  const endMs = firstNumber(utterance, ["endMs", "end_ms", "end_time", "end"]);
  const text = asString(utterance.text) ?? asString(utterance.message) ?? "";
  if (startMs === undefined || endMs === undefined) {
    return undefined;
  }

  const additions = asObject(utterance.additions);
  // VERIFY against real Doubao output: the public sample omits `additions`, so
  // these field names are deliberately best-effort and must stay defensive.
  const speaker = firstString(utterance, ["speaker", "speaker_id"]) ?? firstString(additions, ["speaker", "speaker_id"]);
  const emotion = firstString(utterance, ["emotion"]) ?? firstString(additions, ["emotion", "emotion_label"]);
  const speechRate = firstNumber(utterance, ["speechRate", "speech_rate"]) ?? firstNumber(additions, ["speechRate", "speech_rate"]);
  const volume = firstNumber(utterance, ["volume"]) ?? firstNumber(additions, ["volume"]);
  const gender = firstString(utterance, ["gender"]) ?? firstString(additions, ["gender"]);

  return {
    startMs,
    endMs,
    text,
    ...(speaker ? { speaker } : {}),
    ...(emotion ? { emotion } : {}),
    ...(speechRate !== undefined ? { speechRate } : {}),
    ...(volume !== undefined ? { volume } : {}),
    ...(gender ? { gender } : {}),
  };
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function firstString(object: JsonObject | undefined, keys: string[]): string | undefined {
  if (!object) {
    return undefined;
  }
  for (const key of keys) {
    const value = asString(object[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function firstNumber(object: JsonObject | undefined, keys: string[]): number | undefined {
  if (!object) {
    return undefined;
  }
  for (const key of keys) {
    const value = asNumber(object[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function asrStatusError(statusCode: string | null, response: Response): RuntimeError {
  const status = statusCode ?? "missing";
  if (status === "45000132") {
    return new RuntimeError({
      code: "INVALID_ARGS",
      message: "Doubao ASR rejected the audio size. Use a smaller file, shorter clip, or provider-supported audio URL.",
      retriable: false,
      details: { category: "asr", statusCode: status, httpStatus: response.status },
    });
  }
  if (INVALID_ARG_STATUS.has(status)) {
    return new RuntimeError({
      code: "INVALID_ARGS",
      message: `Doubao ASR rejected the request with status ${status}.`,
      retriable: false,
      details: { category: "asr", statusCode: status, httpStatus: response.status },
    });
  }
  if (RETRIABLE_STATUS.has(status)) {
    return new RuntimeError({
      code: "MODEL_ERROR",
      message: `Doubao ASR returned retriable status ${status}.`,
      retriable: true,
      details: { category: "asr", statusCode: status, httpStatus: response.status },
    });
  }
  return new RuntimeError({
    code: "MODEL_ERROR",
    message: `Doubao ASR returned unexpected status ${status}.`,
    retriable: false,
    details: { category: "asr", statusCode: status, httpStatus: response.status },
  });
}

function toAsrNetworkError(error: unknown): RuntimeError {
  const message = error instanceof Error ? error.message : "Doubao ASR request failed";
  return new RuntimeError({
    code: "MODEL_ERROR",
    message,
    retriable: true,
    details: { category: "asr" },
  });
}
