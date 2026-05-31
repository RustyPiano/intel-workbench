import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { callAsr, TURBO_UNSUPPORTED_REQUEST_FIELDS } from "../model/asr.js";
import { ASR_TURBO_HARD_MAX_BYTES, DEFAULT_ASR_TURBO_MAX_BYTES } from "../model/media-limits.js";
import { isSupportedAudioUrlFormat, mediaMimeType } from "../model/media-source.js";
import {
  publishFileToTos,
  toPublishedMediaMetadata,
  type PublishedMediaMetadata,
} from "../model/tos-storage.js";
import { RuntimeError, toRuntimeErrorShape } from "../runtime/errors.js";
import type { RuntimeTool, ToolContext } from "./types.js";
import { persistToolResult } from "./utils/persist-result.js";
import { truncatePreview } from "./utils/truncate-preview.js";

const analyzeAudioArgsSchema = z
  .object({
    url: z.string().url().optional().describe("Model-reachable URL to an audio file."),
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Path to a local audio file in the workspace. Turbo can send supported local formats inline; standard needs a model-reachable URL, using TOS for local files when configured.",
      ),
    format: z
      .string()
      .min(1)
      .optional()
      .describe("Audio format, e.g. wav, mp3, ogg, m4a, or 3gpp. Required for URL inputs; inferred from path inputs when omitted."),
    out_path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional. Workspace-relative path to persist the full ASR result JSON, including the raw provider payload (e.g. `av-tasks/<id>/analysis/audio-asr.json`); the tool then returns a short summary. Omit to get the transcript and utterances inline — prefer naming a path for long recordings to keep the conversation small.",
      ),
    engine: z
      .enum(["standard", "turbo"])
      .describe(
        "Required ASR engine chosen by the caller. Use 'turbo' (volc.bigasr.auc_turbo) for fast transcription/speaker separation when audio is wav/mp3/ogg/opus, including local inline audio without TOS. For local unsupported formats such as m4a and no rich metadata requirement, convert with ffmpeg to a supported turbo format and retry. Use 'standard' (volc.seedasr.auc) when the user needs rich metadata such as emotion/gender/speech-rate/volume, long/large audio, or preserving the original format; standard requires a model-reachable URL, with local files uploaded through TOS when configured.",
      ),
    language: z.string().min(1).optional().describe("Optional recognition language hint passed to Doubao ASR."),
    speaker: z
      .boolean()
      .optional()
      .describe("Request speaker separation metadata (standard and turbo). Defaults to on."),
    emotion: z
      .boolean()
      .optional()
      .describe("Request per-utterance emotion metadata. Standard only — ignored by turbo, which reports it under capabilitiesDropped. Defaults to on for standard."),
    hotwords: z.array(z.string().min(1)).optional().describe("Domain terms to bias recognition."),
    advanced: z
      .string()
      .optional()
      .describe("Advanced escape hatch: raw JSON object string merged into the Doubao provider request."),
  })
  .superRefine((value, ctx) => {
    const hasUrl = value.url !== undefined;
    const hasPath = value.path !== undefined;
    if (hasUrl === hasPath) {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: "Provide exactly one of path or url.",
      });
    }
    if (hasUrl && value.format === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["format"],
        message: "format is required for URL inputs.",
      });
    }
    if (value.format !== undefined && !isSupportedAudioUrlFormat(value.format)) {
      ctx.addIssue({
        code: "custom",
        path: ["format"],
        message: "Unsupported audio format.",
      });
    }
  })
  .strict();

type AnalyzeAudioArgs = z.infer<typeof analyzeAudioArgsSchema>;

interface AnalyzeAudioData {
  outPath?: string;
  durationMs?: number;
  utteranceCount: number;
  speakerCount: number;
  engineUsed: "standard" | "turbo";
  reason: string;
  capabilitiesDropped?: string[];
  source?: { type: "url"; url: string } | { type: "file"; path: string };
  publishedMedia?: PublishedMediaMetadata;
}

export const analyzeAudioTool: RuntimeTool<AnalyzeAudioArgs, AnalyzeAudioData> = {
  name: "analyze_audio",
  description:
    "Transcribe & analyze an audio URL or local path with Doubao ASR. The caller must choose `engine`: `turbo` is fast and can send supported local wav/mp3/ogg/opus inline without TOS, returning transcript+speaker; `standard` is for rich metadata, long/large audio, or preserving original formats, and needs a model-reachable URL (local files use TOS when configured). For local unsupported formats without rich metadata needs, convert with ffmpeg to a turbo-supported format and retry. The result reports `engineUsed`/`capabilitiesDropped`. Use `out_path` for long recordings to persist the full result. ASR transcripts may contain recognition errors — correct them against context when analyzing.",
  inputSchema: analyzeAudioArgsSchema,
  async execute(args, ctx) {
    try {
      const asr = ctx.config.asr;
      if (!asr) {
        throw new RuntimeError({
          code: "MODEL_ERROR",
          message:
            "ASR is not configured. Set MINI_AGENT_ASR_* credentials such as MINI_AGENT_ASR_API_KEY or MINI_AGENT_ASR_APP_KEY + MINI_AGENT_ASR_ACCESS_KEY to enable analyze_audio.",
        });
      }

      const advanced = parseAdvanced(args.advanced);
      const audioInput = await resolveAudioInput(args, ctx);
      const engineUsed = audioInput.engine;
      const capabilitiesDropped = engineUsed === "turbo" ? turboDroppedCapabilities(args, advanced) : [];
      const result = await callAsr({
        config: asr,
        engine: engineUsed,
        url: audioInput.url,
        data: audioInput.data,
        format: audioInput.format,
        language: args.language,
        hotwords: args.hotwords,
        // Default the rich metadata on; the turbo body drops emotion regardless.
        enableSpeakerInfo: args.speaker ?? true,
        enableEmotionDetection: args.emotion ?? true,
        advanced,
        signal: ctx.signal,
      });
      const degradedNote = result.degradedNote;
      const utteranceCount = result.utterances.length;
      const speakerCount = countSpeakers(result.utterances);
      const durationSummary = result.durationMs === undefined ? "unknown duration" : `${result.durationMs}ms`;
      const degradedSummary = degradedNote ? ` Degraded note: ${degradedNote}` : "";
      const droppedSummary = capabilitiesDropped.length > 0 ? ` Dropped on turbo: ${capabilitiesDropped.join(", ")}.` : "";
      const droppedField = capabilitiesDropped.length > 0 ? { capabilitiesDropped } : {};

      if (args.out_path === undefined) {
        // Inline: return the normalized transcript and utterances, but not the
        // bulky raw provider payload (that only goes to a persisted out_path).
        const inline = {
          provider: "doubao-asr",
          engine: engineUsed,
          language: args.language,
          text: result.text,
          durationMs: result.durationMs,
          utterances: result.utterances,
          ...droppedField,
          ...(degradedNote ? { degradedNote } : {}),
        };
        return {
          ok: true,
          content: JSON.stringify(inline, null, 2),
          meta: {
            durationMs: result.durationMs,
            utteranceCount,
            speakerCount,
            engineUsed,
            reason: audioInput.reason,
            ...droppedField,
            ...(audioInput.source ? { source: audioInput.source } : {}),
            ...(audioInput.publishedMedia ? { publishedMedia: audioInput.publishedMedia } : {}),
          },
        };
      }

      const envelope = {
        provider: "doubao-asr",
        engine: engineUsed,
        resourceId: asr.resourceId,
        language: args.language,
        text: result.text,
        durationMs: result.durationMs,
        utterances: result.utterances,
        raw: result.raw,
        ...droppedField,
        ...(audioInput.source ? { source: audioInput.source } : {}),
        ...(audioInput.publishedMedia ? { publishedMedia: audioInput.publishedMedia } : {}),
        ...(degradedNote ? { degradedNote } : {}),
      };

      let persisted: Awaited<ReturnType<typeof persistToolResult>>;
      try {
        persisted = await persistToolResult({
          ctx,
          outPath: args.out_path,
          data: envelope,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to persist analyze_audio result";
        return {
          ok: false,
          content: `${message}. ASR output preview: ${truncatePreview(result.text)}`,
          error: toRuntimeErrorShape(error, "INTERNAL_ERROR"),
        };
      }

      return {
        ok: true,
        content: `Analyzed audio with Doubao ASR (${engineUsed}): ${utteranceCount} utterances, ${durationSummary}, ${speakerCount} speakers.${droppedSummary}${degradedSummary} Wrote result to ${persisted.absPath}; read ${args.out_path} for transcript and utterances.`,
        meta: {
          outPath: persisted.absPath,
          durationMs: result.durationMs,
          utteranceCount,
          speakerCount,
          engineUsed,
          reason: audioInput.reason,
          ...droppedField,
          ...(audioInput.source ? { source: audioInput.source } : {}),
          ...(audioInput.publishedMedia ? { publishedMedia: audioInput.publishedMedia } : {}),
        },
        artifacts: [
          {
            type: "file",
            path: args.out_path,
            description: "analyze_audio result",
          },
        ],
      };
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : "Failed to analyze audio",
        error: toRuntimeErrorShape(error, "MODEL_ERROR"),
      };
    }
  },
};

// Turbo (录音文件极速版) only supports these container/codecs.
const TURBO_AUDIO_FORMATS = new Set(["wav", "mp3", "ogg", "opus"]);

interface ResolvedAudioInput {
  engine: "standard" | "turbo";
  reason: string;
  format: string;
  url?: string;
  data?: string;
  source?: { type: "url"; url: string } | { type: "file"; path: string };
  publishedMedia?: PublishedMediaMetadata;
}

async function resolveAudioInput(args: AnalyzeAudioArgs, ctx: ToolContext): Promise<ResolvedAudioInput> {
  const asr = ctx.config.asr!;
  const isRemote = args.url !== undefined;
  if (isRemote === (args.path !== undefined)) {
    throw new RuntimeError({
      code: "INVALID_ARGS",
      message: "Provide exactly one of path or url, with format for URL inputs.",
    });
  }

  const filePath = isRemote ? undefined : ctx.policy.resolveReadPath(args.path!);
  const format = (args.format ?? (filePath ? path.extname(filePath).slice(1) : "")).toLowerCase();
  if (!isSupportedAudioUrlFormat(format)) {
    throw new RuntimeError({
      code: "INVALID_ARGS",
      message: `Unsupported audio format: ${format || "(none)"}.`,
    });
  }

  const engine = args.engine;
  const reason = `engine explicitly set to ${engine}`;

  if (engine === "turbo") {
    if (!TURBO_AUDIO_FORMATS.has(format)) {
      throw new RuntimeError({
        code: "INVALID_ARGS",
        message:
          `Turbo ASR only supports wav/mp3/ogg/opus; got ${format}. ` +
          'For local files, convert with ffmpeg to wav/mp3/ogg/opus and retry turbo. Use engine "standard" with a URL/TOS when rich metadata or the original format is required.',
      });
    }

    if (isRemote) {
      return { engine, reason, format, url: args.url };
    }

    const data = await readLocalAudioAsBase64(filePath!, asr.turboMaxBytes);
    return { engine, reason, format, data, source: { type: "file", path: filePath! } };
  }

  // Standard engine: requires a model-reachable URL.
  if (isRemote) {
    return { engine, reason, format, url: args.url };
  }

  if (!ctx.config.tos) {
    throw new RuntimeError({
      code: "MODEL_ERROR",
      message:
        "Standard ASR for local audio needs a model-reachable URL or configured TOS. " +
        'If rich metadata is not required, convert locally with ffmpeg to wav/mp3/ogg/opus and retry with engine "turbo"; ' +
        "otherwise provide a pre-signed URL or configure Volcano Engine TOS with MINI_AGENT_TOS_* via `volcengine-media-setup`.",
      details: { category: "tos", missingTosConfig: true },
    });
  }

  ctx.onUpdate?.("Uploading local audio to Volcano Engine TOS for a short-lived ASR URL...");
  const publishedMedia = await publishFileToTos({
    config: ctx.config.tos,
    filePath: filePath!,
    runId: ctx.runId,
    toolCallId: ctx.toolCallId,
    contentType: mediaMimeType(filePath!),
  });

  return {
    engine,
    reason,
    url: publishedMedia.url,
    format,
    source: { type: "file", path: filePath! },
    publishedMedia: toPublishedMediaMetadata(publishedMedia),
  };
}

// Capabilities the user asked for that the turbo engine cannot honor — surfaced
// so the caller can switch to standard rather than silently losing them.
function turboDroppedCapabilities(args: AnalyzeAudioArgs, advanced: Record<string, unknown> | undefined): string[] {
  const dropped: string[] = [];
  if (args.emotion === true) {
    dropped.push("emotion");
  }
  for (const field of TURBO_UNSUPPORTED_REQUEST_FIELDS) {
    // "emotion" already represents enable_emotion_detection; don't list it twice.
    if (field === "enable_emotion_detection" && dropped.includes("emotion")) {
      continue;
    }
    if (advanced && field in advanced && !dropped.includes(field)) {
      dropped.push(field);
    }
  }
  return dropped;
}

async function readLocalAudioAsBase64(filePath: string, configuredMaxBytes: number | undefined): Promise<string> {
  const maxBytes = Math.min(configuredMaxBytes ?? DEFAULT_ASR_TURBO_MAX_BYTES, ASR_TURBO_HARD_MAX_BYTES);
  let size: number;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      throw new RuntimeError({
        code: "INVALID_ARGS",
        message: `Cannot send local audio to turbo ASR because the path is not a file: ${filePath}`,
      });
    }
    size = info.size;
  } catch (error) {
    if (error instanceof RuntimeError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Unknown file access error";
    throw new RuntimeError({
      code: "INVALID_ARGS",
      message: `Cannot read local audio file for turbo ASR: ${filePath}: ${message}`,
    });
  }

  if (size > maxBytes) {
    throw new RuntimeError({
      code: "INVALID_ARGS",
      message:
        `Local audio is ${size} bytes, over the turbo inline limit of ${maxBytes} bytes. ` +
        "Use a shorter/smaller clip, raise MINI_AGENT_ASR_TURBO_MAX_BYTES, or configure TOS and use engine \"standard\".",
    });
  }

  return (await readFile(filePath)).toString("base64");
}

function parseAdvanced(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RuntimeError({
      code: "INVALID_ARGS",
      message: "advanced must be a valid JSON object string.",
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RuntimeError({
      code: "INVALID_ARGS",
      message: "advanced must be a valid JSON object string.",
    });
  }

  return parsed as Record<string, unknown>;
}

function countSpeakers(utterances: Array<{ speaker?: string }>): number {
  return new Set(utterances.map((utterance) => utterance.speaker).filter((speaker): speaker is string => Boolean(speaker))).size;
}
