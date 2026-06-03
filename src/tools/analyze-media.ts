import { stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { RuntimeError, toRuntimeErrorShape } from "../runtime/errors.js";
import { callOmni } from "../model/multimodal.js";
import { base64EncodedLength, MAX_INLINE_BASE64_BYTES } from "../model/media-limits.js";
import {
  detectMediaKind,
  isSupportedAudioUrlFormat,
  mediaMimeType,
  MEDIA_KINDS,
  type MediaKind,
  type MediaSource,
} from "../model/media-source.js";
import {
  publishFileToTos,
  toPublishedMediaMetadata,
  type PublishedMediaMetadata,
} from "../model/tos-storage.js";
import type { RuntimeTool, ToolContext } from "./types.js";
import { persistToolResult } from "./utils/persist-result.js";
import { truncatePreview } from "./utils/truncate-preview.js";

const analyzeMediaArgsSchema = z
  .object({
    path: z.string().min(1).optional().describe("Path to a video, audio, or image file in the workspace."),
    url: z.string().url().optional().describe("Model-reachable URL to a video, audio, or image file."),
    kind: z.enum(MEDIA_KINDS).optional().describe("Required for URL inputs: video, audio, or image."),
    format: z
      .string()
      .min(1)
      .optional()
      .describe("Required for audio URL inputs, e.g. wav or mp3. Ignored for local file inputs."),
    instruction: z
      .string()
      .describe(
        "What to analyze, e.g. 'List key events with MM:SS timestamps' or 'Identify speakers and their emotion at each turn'.",
      ),
    out_path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional. Workspace-relative path to persist the full result JSON (e.g. `av-tasks/<id>/analysis/clip.json`); the tool then returns a short summary to read back. Omit to get the analysis inline — prefer that for images and short clips; name a path for long transcripts to keep the conversation small.",
      ),
    want_json: z
      .boolean()
      .optional()
      .describe(
        "Ask the model to return strict JSON. Describe the desired fields in `instruction`. The JSON is validated either way: it is returned inline, or written to `out_path` when set.",
      ),
  })
  .superRefine((value, ctx) => {
    const hasPath = value.path !== undefined;
    const hasUrl = value.url !== undefined;
    if (hasPath === hasUrl) {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: "Provide exactly one of path or url.",
      });
    }
    if (hasUrl && value.kind === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["kind"],
        message: "kind is required when url is provided.",
      });
    }
    if (hasUrl && value.kind === "audio" && value.format === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["format"],
        message: "format is required for audio URL inputs.",
      });
    }
    if (hasUrl && value.kind === "audio" && value.format !== undefined && !isSupportedAudioUrlFormat(value.format)) {
      ctx.addIssue({
        code: "custom",
        path: ["format"],
        message: "Unsupported audio URL format.",
      });
    }
  })
  .strict();

type AnalyzeMediaArgs = z.infer<typeof analyzeMediaArgsSchema>;

const TOS_SIGNED_URL_REDACTION = "(redacted TOS signed URL)";
const IMAGE_TIMEOUT_MS = 60_000;
const INLINE_AUDIO_VIDEO_TIMEOUT_MS = 120_000;
const URL_VIDEO_TIMEOUT_MS = 300_000;
const OVERSIZED_AUDIO_TIMEOUT_MS = 180_000;
const OVERSIZED_VIDEO_TIMEOUT_MS = 300_000;
const MAX_AUTO_TIMEOUT_MS = 600_000;

interface AnalyzeMediaData {
  source: MediaSource;
  originalSource?: MediaSource;
  publishedMedia?: PublishedMediaMetadata;
  kind: string;
  model: string;
  outPath?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

interface PreparedMediaSource {
  modelSource: MediaSource;
  resultSource: MediaSource;
  originalSource?: MediaSource;
  publishedMedia?: PublishedMediaMetadata;
}

export const analyzeMediaTool: RuntimeTool<AnalyzeMediaArgs, AnalyzeMediaData> = {
  name: "analyze_media",
  description:
    "Analyze a video/audio/image file or model-reachable URL with a multimodal model. Local files are sent inline when small; oversized local media uses configured TOS automatic upload. Use for event detection with timestamps, speaker analysis, emotion recognition, and multimodal summaries. Returns the model's analysis inline by default; pass `out_path` to persist the full result (text + parsed JSON) and get a short summary back instead — prefer that for long transcripts.",
  inputSchema: analyzeMediaArgsSchema,
  getTimeoutMs: estimateAnalyzeMediaTimeoutMs,
  async execute(args, ctx) {
    try {
      const multimodal = ctx.config.multimodal;
      if (!multimodal) {
        throw new RuntimeError({
          code: "MODEL_ERROR",
          message:
            "Multimodal model is not configured. Set MINI_AGENT_MM_MODEL (and MINI_AGENT_MM_API_KEY / MINI_AGENT_MM_BASE_URL) to enable analyze_media.",
        });
      }

      const prepared = await prepareMediaSource(args, ctx);
      if (!prepared.publishedMedia) {
        ctx.onUpdate?.("Calling multimodal model...");
      }
      const result = await callOmni({
        config: multimodal,
        source: prepared.modelSource,
        instruction: args.instruction,
        jsonMode: args.want_json === true,
        signal: ctx.signal,
      });
      ctx.onUpdate?.("Multimodal model response completed.");
      if (args.out_path === undefined) {
        return {
          ok: true,
          content: result.text,
          meta: {
            source: prepared.resultSource,
            ...(prepared.originalSource ? { originalSource: prepared.originalSource } : {}),
            ...(prepared.publishedMedia ? { publishedMedia: prepared.publishedMedia } : {}),
            kind: result.kind,
            model: result.model,
            usage: result.usage,
          },
        };
      }

      const envelope = {
        source: prepared.resultSource,
        ...(prepared.originalSource ? { originalSource: prepared.originalSource } : {}),
        ...(prepared.publishedMedia ? { publishedMedia: prepared.publishedMedia } : {}),
        kind: result.kind,
        model: result.model,
        text: result.text,
        json: result.json,
        usage: result.usage,
      };

      let persisted: Awaited<ReturnType<typeof persistToolResult>>;
      try {
        persisted = await persistToolResult({
          ctx,
          outPath: args.out_path,
          data: envelope,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to persist analyze_media result";
        return {
          ok: false,
          content: `${message}. Model output preview: ${truncatePreview(result.text)}`,
          error: toRuntimeErrorShape(error, "INTERNAL_ERROR"),
        };
      }

      return {
        ok: true,
        content: `Analyzed ${result.kind} with ${result.model}; wrote result to ${persisted.absPath} (${persisted.bytesWritten} bytes).\nRead ${args.out_path} for the complete output.`,
        meta: {
          source: prepared.resultSource,
          ...(prepared.originalSource ? { originalSource: prepared.originalSource } : {}),
          ...(prepared.publishedMedia ? { publishedMedia: prepared.publishedMedia } : {}),
          kind: result.kind,
          model: result.model,
          outPath: persisted.absPath,
          usage: result.usage,
        },
        artifacts: [
          {
            type: "file",
            path: args.out_path,
            description: "analyze_media result",
          },
        ],
      };
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : "Failed to analyze media",
        error: toRuntimeErrorShape(error, "MODEL_ERROR"),
      };
    }
  },
};

async function estimateAnalyzeMediaTimeoutMs(args: AnalyzeMediaArgs, ctx: ToolContext): Promise<number | undefined> {
  const source = toMediaSource(args, ctx.policy.resolveReadPath.bind(ctx.policy));
  if (source.type === "url") {
    return source.kind === "video" ? URL_VIDEO_TIMEOUT_MS : source.kind === "audio" ? INLINE_AUDIO_VIDEO_TIMEOUT_MS : IMAGE_TIMEOUT_MS;
  }

  const kind = detectMediaKind(source.path);
  if (kind === "image") {
    return IMAGE_TIMEOUT_MS;
  }

  const fileInfo = await statLocalMedia(source.path);
  const encodedLength = base64EncodedLength(fileInfo.size);
  if (encodedLength < MAX_INLINE_BASE64_BYTES) {
    return INLINE_AUDIO_VIDEO_TIMEOUT_MS;
  }

  if (kind === "audio") {
    return OVERSIZED_AUDIO_TIMEOUT_MS;
  }

  const extraBytes = Math.max(0, fileInfo.size - MAX_INLINE_BASE64_BYTES);
  const extraTimeoutMs = Math.ceil(extraBytes / 50_000_000) * 60_000;
  return Math.min(OVERSIZED_VIDEO_TIMEOUT_MS + extraTimeoutMs, MAX_AUTO_TIMEOUT_MS);
}

async function prepareMediaSource(
  args: AnalyzeMediaArgs,
  ctx: ToolContext,
): Promise<PreparedMediaSource> {
  const source = toMediaSource(args, ctx.policy.resolveReadPath.bind(ctx.policy));
  if (source.type === "url") {
    return { modelSource: source, resultSource: source };
  }

  const kind = detectMediaKind(source.path);
  const fileInfo = await statLocalMedia(source.path);
  const encodedLength = base64EncodedLength(fileInfo.size);
  if (encodedLength < MAX_INLINE_BASE64_BYTES) {
    return { modelSource: source, resultSource: source };
  }

  if (!ctx.config.tos) {
    throw new RuntimeError({
      code: "INVALID_ARGS",
      message:
        `Media file is too large for inline Base64 (${encodedLength} bytes after encoding; limit is under ` +
        `${MAX_INLINE_BASE64_BYTES} bytes). Configure Volcano Engine TOS with MINI_AGENT_TOS_* and use ` +
        "`volcengine-media-setup`, pass a model-reachable URL, split the media, or compress it first.",
      details: {
        category: "multimodal",
        fileSizeBytes: fileInfo.size,
        encodedSizeBytes: encodedLength,
        maxInlineBase64Bytes: MAX_INLINE_BASE64_BYTES,
        missingTosConfig: true,
      },
    });
  }

  ctx.onUpdate?.("Uploading oversized local media to Volcano Engine TOS for a short-lived model URL...");
  const publishedMedia = await publishFileToTos({
    config: ctx.config.tos,
    filePath: source.path,
    runId: ctx.runId,
    toolCallId: ctx.toolCallId,
    contentType: mediaMimeType(source.path),
  });
  ctx.onUpdate?.("Upload completed; calling multimodal model with the published media URL...");

  const modelSource = toPublishedUrlSource(kind, publishedMedia.url, source.path);
  return {
    modelSource,
    resultSource: redactPublishedUrlSource(modelSource),
    originalSource: source,
    publishedMedia: toPublishedMediaMetadata(publishedMedia),
  };
}

function redactPublishedUrlSource(source: MediaSource): MediaSource {
  if (source.type !== "url") {
    return source;
  }
  return { ...source, url: TOS_SIGNED_URL_REDACTION };
}

function toPublishedUrlSource(kind: MediaKind, url: string, filePath: string): MediaSource {
  if (kind === "audio") {
    return { type: "url", url, kind, format: path.extname(filePath).slice(1).toLowerCase() };
  }
  return { type: "url", url, kind };
}

async function statLocalMedia(filePath: string): Promise<Stats> {
  try {
    const file = (await stat(filePath)) as Stats;
    if (!file.isFile()) {
      throw new RuntimeError({
        code: "INVALID_ARGS",
        message: `Cannot analyze local media because the path is not a file: ${filePath}`,
        details: {
          category: "file",
          path: filePath,
        },
      });
    }
    return file;
  } catch (error) {
    if (error instanceof RuntimeError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Unknown file access error";
    throw new RuntimeError({
      code: "INVALID_ARGS",
      message: `Cannot read local media file: ${filePath}: ${message}`,
      details: {
        category: "file",
        path: filePath,
        cause: message,
      },
    });
  }
}

// `analyzeMediaArgsSchema.superRefine` already guarantees exactly one of
// path/url, a kind for URLs, and a format for audio URLs. The branches below
// only re-narrow those guarantees for the typed `MediaSource`; the trailing
// throw is an unreachable invariant guard.
function toMediaSource(args: AnalyzeMediaArgs, resolveReadPath: (path: string) => string): MediaSource {
  if (args.path !== undefined) {
    return { type: "file", path: resolveReadPath(args.path) };
  }
  if (args.url !== undefined && args.kind === "audio" && args.format !== undefined) {
    return { type: "url", url: args.url, kind: "audio", format: args.format.toLowerCase() };
  }
  if (args.url !== undefined && (args.kind === "video" || args.kind === "image")) {
    return { type: "url", url: args.url, kind: args.kind };
  }
  throw new RuntimeError({
    code: "INVALID_ARGS",
    message: "Provide exactly one of path or url, with a kind for URLs and a format for audio URLs.",
  });
}
