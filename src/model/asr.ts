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

export type AsrEngine = "standard" | "turbo";

export interface AsrClientConfig {
  baseURL: string;
  resourceId: string;
  appId?: string;
  apiKey?: string;
  appKey?: string;
  accessKey?: string;
  timeoutMs?: number;
  // Resource ID for the recording-flash (极速版) engine; defaults to the
  // documented `volc.bigasr.auc_turbo` when unset.
  turboResourceId?: string;
}

export interface CallAsrParams {
  config: AsrClientConfig;
  // Standard always uses `url`. Turbo accepts either a model-reachable `url` or
  // an inline base64 `data` payload (exactly one must be provided).
  url?: string;
  data?: string;
  format: string;
  engine: AsrEngine;
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
const FLASH_PATH = "/api/v3/auc/bigmodel/recognize/flash";
const DEFAULT_TURBO_RESOURCE_ID = "volc.bigasr.auc_turbo";
const DEFAULT_TIMEOUT_MS = 120_000;

// Fields the flash (极速版) engine removes relative to the standard request
// (callback + 客服能力). They are stripped from the turbo body even if a caller
// re-injects them through `advanced`, so the wire request can never carry them.
export const TURBO_UNSUPPORTED_REQUEST_FIELDS = [
  "enable_emotion_detection",
  "enable_gender_detection",
  "enable_lid",
  "show_volume",
  "show_speech_rate",
  "callback",
  "callback_data",
] as const;
const DEFAULT_POLL_DELAYS_MS = [2_000, 3_000, 5_000, 10_000];
const PROCESSING_CODES = new Set(["20000001", "20000002"]);

const INVALID_ARG_STATUS = new Set(["45000001", "45000002", "45000151"]);
const RETRIABLE_STATUS = new Set(["45000131", "55000031"]);

type JsonObject = Record<string, unknown>;

export async function callAsr(params: CallAsrParams): Promise<AsrResult> {
  if (params.engine !== "standard" && params.engine !== "turbo") {
    throw new RuntimeError({
      code: "INVALID_ARGS",
      message: 'Doubao ASR engine is required. Pass engine "standard" or "turbo".',
      retriable: false,
      details: { category: "asr" },
    });
  }

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

  try {
    return params.engine === "turbo"
      ? await runTurbo(params, fetchFn, requestId)
      : await runStandard(params, fetchFn, requestId, startedAt, timeoutMs);
  } catch (error) {
    if (isAbortError(error, params.signal)) {
      throw new RuntimeError({
        code: "RUN_ABORTED",
        message: "Doubao ASR request was aborted.",
        retriable: true,
        details: { category: "asr" },
      });
    }
    if (error instanceof RuntimeError) {
      throw error;
    }
    throw toAsrNetworkError(error);
  }
}

// 录音文件识别标准版 (volc.seedasr.auc): submit then poll query until done.
async function runStandard(
  params: CallAsrParams,
  fetchFn: typeof fetch,
  requestId: string,
  startedAt: number,
  timeoutMs: number,
): Promise<AsrResult> {
  if (!params.url) {
    throw new RuntimeError({
      code: "INVALID_ARGS",
      message: "Standard Doubao ASR requires a model-reachable audio URL.",
      retriable: false,
      details: { category: "asr" },
    });
  }

  const headers = buildHeaders(params.config, requestId, params.config.resourceId);
  const submitBody = buildSubmitBody(params);

  const submitResponse = await postJson(fetchFn, buildURL(params.config.baseURL, SUBMIT_PATH), headers, submitBody, params.signal);
  // Doubao reports logical failures (bad params, auth, unreachable audio) via the
  // status header on an HTTP 200, so surface a submit-time error immediately
  // instead of polling a task that was never accepted. A missing header is
  // tolerated for gateways that only set it on query.
  const submitStatus = submitResponse.headers.get("X-Api-Status-Code") ?? submitResponse.headers.get("x-api-status-code");
  if (submitStatus && submitStatus !== "20000000" && !PROCESSING_CODES.has(submitStatus)) {
    throw asrStatusError(submitStatus, submitResponse);
  }

  for (let attempt = 0; ; attempt += 1) {
    assertWithinTimeout(startedAt, timeoutMs);
    const response = await postJson(fetchFn, buildURL(params.config.baseURL, QUERY_PATH), headers, {}, params.signal);
    const statusCode = response.headers.get("X-Api-Status-Code") ?? response.headers.get("x-api-status-code");

    if (statusCode === "20000000") {
      return normalizeAsrResult(await parseResponseJson(response));
    }
    if (statusCode === "20000003") {
      return silentResult(await parseResponseJson(response));
    }
    if (statusCode && PROCESSING_CODES.has(statusCode)) {
      await waitBeforeNextPoll(params.pollDelaysMs ?? DEFAULT_POLL_DELAYS_MS, attempt, startedAt, timeoutMs, params.signal);
      continue;
    }

    throw asrStatusError(statusCode, response);
  }
}

// 录音文件极速版 (volc.bigasr.auc_turbo): one request returns the result, no
// polling. Accepts a base64 `data` payload, so local audio needs no TOS URL.
async function runTurbo(params: CallAsrParams, fetchFn: typeof fetch, requestId: string): Promise<AsrResult> {
  if (!params.url && !params.data) {
    throw new RuntimeError({
      code: "INVALID_ARGS",
      message: "Turbo Doubao ASR requires either a URL or base64 audio data.",
      retriable: false,
      details: { category: "asr" },
    });
  }

  const resourceId = params.config.turboResourceId ?? DEFAULT_TURBO_RESOURCE_ID;
  const headers = buildHeaders(params.config, requestId, resourceId);
  const response = await postJson(fetchFn, buildURL(params.config.baseURL, FLASH_PATH), headers, buildFlashBody(params), params.signal);
  const statusCode = response.headers.get("X-Api-Status-Code") ?? response.headers.get("x-api-status-code");

  if (statusCode === "20000000") {
    return normalizeAsrResult(await parseResponseJson(response));
  }
  if (statusCode === "20000003") {
    return silentResult(await parseResponseJson(response));
  }

  throw asrStatusError(statusCode, response);
}

function silentResult(raw: unknown): AsrResult {
  return {
    text: "",
    utterances: [],
    raw,
    degradedNote: "Doubao ASR reported silent audio; returning an empty transcript.",
  };
}

function buildHeaders(config: AsrClientConfig, requestId: string, resourceId: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Resource-Id": resourceId,
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
  // `show_utterances` is pinned on: normalizeAsrResult depends on the utterance
  // list, so `advanced` cannot disable it (other request fields stay overridable).
  request.show_utterances = true;

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

function buildFlashBody(params: CallAsrParams): JsonObject {
  // The flash engine drops callback and the 客服能力 fields
  // (enable_emotion_detection / gender / lid / volume / speech_rate), so they
  // are intentionally never sent here — only transcription + speaker survive.
  const request: JsonObject = {
    model_name: "bigmodel",
    enable_punc: true,
    enable_itn: true,
    enable_speaker_info: params.enableSpeakerInfo ?? true,
  };
  if (params.language) {
    request.language = params.language;
  }
  if (params.hotwords?.length) {
    request.context = { hotwords: params.hotwords };
  }
  Object.assign(request, params.advanced ?? {});
  for (const field of TURBO_UNSUPPORTED_REQUEST_FIELDS) {
    delete request[field];
  }
  request.show_utterances = true;

  // url and data are mutually exclusive; runTurbo guarantees one is present.
  const audio: JsonObject = params.data !== undefined ? { data: params.data } : { url: params.url };
  audio.format = params.format;
  Object.assign(audio, params.audio ?? {});

  return {
    user: params.user ?? params.config.appId ?? "mini-agent",
    audio,
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

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}
