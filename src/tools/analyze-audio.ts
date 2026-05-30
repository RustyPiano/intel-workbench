import { z } from "zod";

import { callAsr } from "../model/asr.js";
import { RuntimeError, toRuntimeErrorShape } from "../runtime/errors.js";
import type { RuntimeTool } from "./types.js";
import { persistToolResult } from "./utils/persist-result.js";

const analyzeAudioArgsSchema = z
  .object({
    url: z.string().url().describe("Public URL to an audio file."),
    format: z.string().min(1).describe("Audio format for the public URL, e.g. wav, mp3, ogg, pcm, m4a, or 3gpp."),
    out_path: z
      .string()
      .min(1)
      .describe(
        "Workspace-relative path where the full ASR result JSON is written. You choose it (e.g. `av-tasks/<id>/analysis/audio-asr.json`).",
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
  outPath: string;
  durationMs?: number;
  utteranceCount: number;
  speakerCount: number;
}

export const analyzeAudioTool: RuntimeTool<AnalyzeAudioArgs, AnalyzeAudioData> = {
  name: "analyze_audio",
  description:
    "Transcribe & analyze a public audio URL with the Doubao recording model: word/utterance timestamps, speaker separation, per-utterance emotion, speech-rate, volume, gender. Writes the full result JSON to `out_path`; read that file for transcript + utterances. Use for meeting/interview/call audio. For video, use `analyze_media` instead. Transcripts may contain recognition errors; re-read the audio context and correct them when analyzing.",
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

      const persisted = await persistToolResult({
        ctx,
        outPath: args.out_path,
        data: envelope,
      });
      const utteranceCount = result.utterances.length;
      const speakerCount = countSpeakers(result.utterances);
      const durationSummary = result.durationMs === undefined ? "unknown duration" : `${result.durationMs}ms`;

      return {
        ok: true,
        content: `Analyzed audio with Doubao ASR: ${utteranceCount} utterances, ${durationSummary}, ${speakerCount} speakers. Wrote result to ${persisted.absPath}; read ${args.out_path} for transcript and utterances.`,
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
