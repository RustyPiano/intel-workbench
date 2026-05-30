import { z } from "zod";

import { callAsr } from "../model/asr.js";
import { RuntimeError, toRuntimeErrorShape } from "../runtime/errors.js";
import type { RuntimeTool } from "./types.js";
import { persistToolResult } from "./utils/persist-result.js";
import { truncatePreview } from "./utils/truncate-preview.js";

const analyzeAudioArgsSchema = z
  .object({
    url: z.string().url().describe("Public URL to an audio file."),
    format: z.string().min(1).describe("Audio format for the public URL, e.g. wav, mp3, ogg, pcm, m4a, or 3gpp."),
    out_path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional. Workspace-relative path to persist the full ASR result JSON, including the raw provider payload (e.g. `av-tasks/<id>/analysis/audio-asr.json`); the tool then returns a short summary. Omit to get the transcript and utterances inline — prefer naming a path for long recordings to keep the conversation small.",
      ),
    language: z.string().min(1).optional().describe("Optional recognition language hint passed to Doubao ASR."),
    speaker: z
      .boolean()
      .default(true)
      .describe("Enable speaker separation metadata when supported by the provider. Defaults to true."),
    emotion: z
      .boolean()
      .default(true)
      .describe("Enable per-utterance emotion metadata when supported by the provider. Defaults to true."),
    hotwords: z.array(z.string().min(1)).optional().describe("Domain terms to bias recognition."),
    advanced: z
      .string()
      .optional()
      .describe("Advanced escape hatch: raw JSON object string merged into the Doubao provider request."),
  })
  .strict();

type AnalyzeAudioArgs = z.infer<typeof analyzeAudioArgsSchema>;

interface AnalyzeAudioData {
  outPath?: string;
  durationMs?: number;
  utteranceCount: number;
  speakerCount: number;
}

export const analyzeAudioTool: RuntimeTool<AnalyzeAudioArgs, AnalyzeAudioData> = {
  name: "analyze_audio",
  description:
    "Transcribe & analyze a public audio URL with the Doubao recording model: word/utterance timestamps, speaker separation, per-utterance emotion, speech-rate, volume, gender. Returns the transcript and utterances inline; pass `out_path` to instead persist the full result (incl. raw provider payload) and get a short summary back — prefer that for long recordings. Use for meeting/interview/call audio; for video use `analyze_media`. ASR transcripts may contain recognition errors — correct them against the surrounding transcript context when analyzing.",
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
      const result = await callAsr({
        config: asr,
        url: args.url,
        format: args.format,
        language: args.language,
        hotwords: args.hotwords,
        enableSpeakerInfo: args.speaker,
        enableEmotionDetection: args.emotion,
        advanced,
        signal: ctx.signal,
      });
      const utteranceCount = result.utterances.length;
      const speakerCount = countSpeakers(result.utterances);
      const durationSummary = result.durationMs === undefined ? "unknown duration" : `${result.durationMs}ms`;
      const degradedSummary = result.degradedNote ? ` Degraded note: ${result.degradedNote}` : "";

      if (args.out_path === undefined) {
        // Inline: return the normalized transcript and utterances, but not the
        // bulky raw provider payload (that only goes to a persisted out_path).
        const inline = {
          provider: "doubao-asr",
          language: args.language,
          text: result.text,
          durationMs: result.durationMs,
          utterances: result.utterances,
          ...(result.degradedNote ? { degradedNote: result.degradedNote } : {}),
        };
        return {
          ok: true,
          content: JSON.stringify(inline, null, 2),
          meta: { durationMs: result.durationMs, utteranceCount, speakerCount },
        };
      }

      const envelope = {
        provider: "doubao-asr",
        resourceId: asr.resourceId,
        language: args.language,
        text: result.text,
        durationMs: result.durationMs,
        utterances: result.utterances,
        raw: result.raw,
        ...(result.degradedNote ? { degradedNote: result.degradedNote } : {}),
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
        content: `Analyzed audio with Doubao ASR: ${utteranceCount} utterances, ${durationSummary}, ${speakerCount} speakers.${degradedSummary} Wrote result to ${persisted.absPath}; read ${args.out_path} for transcript and utterances.`,
        meta: {
          outPath: persisted.absPath,
          durationMs: result.durationMs,
          utteranceCount,
          speakerCount,
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
