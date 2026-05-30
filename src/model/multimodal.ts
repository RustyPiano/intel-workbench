import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import OpenAI from "openai";

import { RuntimeError } from "../runtime/errors.js";
import type { MultimodalToolConfig } from "../tools/types.js";
import { base64EncodedLength, MAX_INLINE_BASE64_BYTES } from "./media-limits.js";
import { AUDIO_FORMATS, type MediaKind, type MediaSource } from "./media-source.js";

/**
 * Multimodal model access for the media tools.
 *
 * This module deliberately lives *outside* the text agent loop: the runtime's
 * `ModelAdapter` and `RuntimeMessage` stay string-only, while audio/video/image
 * bytes are packaged into OpenAI-compatible multimodal `content` parts here and
 * sent directly to an omni model (e.g. `qwen3.5-omni-*` on DashScope, which
 * speaks the standard `/v1/chat/completions` shape). The tool receives back
 * plain text (or parsed JSON), so nothing multimodal ever enters the loop's
 * message history, session JSONL, or trace.
 */

export type { MediaKind, MediaSource } from "./media-source.js";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".mpeg", ".mpg"]);
const AUDIO_EXTENSIONS = new Set(AUDIO_FORMATS.map((format) => `.${format}`));
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

const MIME_BY_EXTENSION: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".m4v": "video/x-m4v",
  ".flv": "video/x-flv",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/opus",
  ".wma": "audio/x-ms-wma",
  ".amr": "audio/amr",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export function detectMediaKind(filePath: string): MediaKind {
  const ext = path.extname(filePath).toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) {
    return "video";
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return "audio";
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }

  throw new RuntimeError({
    code: "INVALID_ARGS",
    message: `Unsupported media file extension: ${ext || "(none)"}. Supported: video, audio, image.`,
  });
}

export function mediaMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

/**
 * Build the OpenAI-compatible multimodal `content` part for a media file
 * encoded as a base64 data URL. `format` is the bare extension (e.g. `mp3`),
 * required by the `input_audio` part shape.
 */
export function buildMediaContentPart(kind: MediaKind, dataUrl: string, format: string): Record<string, unknown> {
  switch (kind) {
    case "video":
      return { type: "video_url", video_url: { url: dataUrl } };
    case "audio":
      return { type: "input_audio", input_audio: { data: dataUrl, format } };
    case "image":
      return { type: "image_url", image_url: { url: dataUrl } };
  }
}

/**
 * Minimal structural client so a real `OpenAI` instance and a test fake both
 * satisfy it. Qwen-Omni only supports streaming output (per the DashScope docs:
 * "stream must be set to True, otherwise an error occurs"), so `create` returns
 * an async-iterable of chunks. The request/response are intentionally loose
 * because multimodal `content` parts (`video_url`, `input_audio`) are not in the
 * SDK's typed surface.
 */
export interface OmniStreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

export interface OmniClient {
  chat: {
    completions: {
      create(
        body: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ): Promise<AsyncIterable<OmniStreamChunk>>;
    };
  };
}

export function createOmniClient(config: MultimodalToolConfig): OmniClient {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  }) as unknown as OmniClient;
}

export interface CallOmniParams {
  config: MultimodalToolConfig;
  source: MediaSource;
  instruction: string;
  /** When true, ask for JSON output and parse it into `json`. */
  jsonMode?: boolean;
  systemPrompt?: string;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to a client built from `config`. */
  client?: OmniClient;
}

export interface OmniResult {
  text: string;
  json?: unknown;
  kind: MediaKind;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

const JSON_FENCE = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/u;

function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed.match(JSON_FENCE)?.[1] ?? trimmed;
  try {
    return JSON.parse(unfenced);
  } catch {
    // Fall back to the first balanced {...} or [...] span if the model wrapped
    // the JSON in prose.
    const firstBrace = unfenced.search(/[[{]/u);
    const lastBrace = Math.max(unfenced.lastIndexOf("}"), unfenced.lastIndexOf("]"));
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(unfenced.slice(firstBrace, lastBrace + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function toMultimodalError(error: unknown): RuntimeError {
  if (error instanceof RuntimeError) {
    return error;
  }
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
  const message = error instanceof Error ? error.message : "Multimodal model request failed";
  return new RuntimeError({
    code: "MODEL_ERROR",
    message: status ? `${status} ${message}` : message,
    retriable: status === 429 || status === 503,
    details: { category: "multimodal", status },
  });
}

export async function callOmni(params: CallOmniParams): Promise<OmniResult> {
  if (!params.config.model) {
    throw new RuntimeError({
      code: "MODEL_ERROR",
      message: "No multimodal model configured. Set MINI_AGENT_MM_MODEL (e.g. qwen3.5-omni-plus).",
    });
  }
  if (!params.client && !params.config.apiKey) {
    throw new RuntimeError({
      code: "MODEL_ERROR",
      message: "No multimodal API key configured. Set MINI_AGENT_MM_API_KEY (or reuse MINI_AGENT_API_KEY).",
    });
  }

  const { kind, mediaPart } = await buildMediaContentForSource(params.source);

  // Qwen-Omni does not document `response_format: json_object`, so we steer the
  // model to JSON through the instruction and parse it ourselves instead.
  const instruction = params.jsonMode
    ? `${params.instruction}\n\nRespond with a single valid JSON document and nothing else.`
    : params.instruction;

  const messages: Array<Record<string, unknown>> = [];
  if (params.systemPrompt) {
    messages.push({ role: "system", content: params.systemPrompt });
  }
  messages.push({
    role: "user",
    content: [mediaPart, { type: "text", text: instruction }],
  });

  // Streaming is mandatory for Qwen-Omni; accumulate the text deltas.
  const body: Record<string, unknown> = {
    model: params.config.model,
    messages,
    modalities: ["text"],
    stream: true,
    stream_options: { include_usage: true },
  };

  const client = params.client ?? createOmniClient(params.config);

  let text = "";
  let usage: OmniResult["usage"];
  try {
    const stream = await client.chat.completions.create(body, { signal: params.signal });
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string") {
        text += delta;
      }
      if (chunk.usage) {
        usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
      }
    }
  } catch (error) {
    throw toMultimodalError(error);
  }

  const parsedJson = params.jsonMode ? parseJsonLoose(text) : undefined;
  if (params.jsonMode && parsedJson === undefined) {
    throw new RuntimeError({
      code: "MODEL_ERROR",
      message: "Multimodal model returned invalid JSON for a want_json request.",
      retriable: true,
      details: {
        category: "invalid_model_output",
        outputPreview: text.slice(0, 1000),
      },
    });
  }

  return {
    text,
    json: parsedJson,
    kind,
    model: params.config.model,
    usage,
  };
}

async function buildMediaContentForSource(source: MediaSource): Promise<{ kind: MediaKind; mediaPart: Record<string, unknown> }> {
  if (source.type === "url") {
    const format = source.kind === "audio" ? source.format.toLowerCase() : "";
    return {
      kind: source.kind,
      mediaPart: buildMediaContentPart(source.kind, source.url, format),
    };
  }

  const kind = detectMediaKind(source.path);
  const fileInfo = await stat(source.path);
  const encodedLength = base64EncodedLength(fileInfo.size);
  if (encodedLength >= MAX_INLINE_BASE64_BYTES) {
    throw new RuntimeError({
      code: "INVALID_ARGS",
      message:
        `Media file is too large for inline Base64 (${encodedLength} bytes after encoding; limit is under ` +
        `${MAX_INLINE_BASE64_BYTES} bytes). Use a public URL, split the media, or compress it first.`,
      details: {
        category: "multimodal",
        fileSizeBytes: fileInfo.size,
        encodedSizeBytes: encodedLength,
        maxInlineBase64Bytes: MAX_INLINE_BASE64_BYTES,
      },
    });
  }
  const bytes = await readFile(source.path);
  const base64 = bytes.toString("base64");
  // Per DashScope's local-file examples, audio and video data URLs omit the
  // MIME type; images keep their MIME type.
  const dataUrl = kind === "image" ? `data:${mediaMimeType(source.path)};base64,${base64}` : `data:;base64,${base64}`;
  const format = path.extname(source.path).slice(1).toLowerCase();
  return { kind, mediaPart: buildMediaContentPart(kind, dataUrl, format) };
}
