import { z } from "zod";

import { RuntimeError, toRuntimeErrorShape } from "../runtime/errors.js";
import { callOmni } from "../model/multimodal.js";
import { isSupportedAudioUrlFormat, MEDIA_KINDS, type MediaSource } from "../model/media-source.js";
import type { RuntimeTool } from "./types.js";
import { persistToolResult } from "./utils/persist-result.js";
import { truncatePreview } from "./utils/truncate-preview.js";

const analyzeMediaArgsSchema = z
  .object({
    path: z.string().min(1).optional().describe("Path to a video, audio, or image file in the workspace."),
    url: z.string().url().optional().describe("Public URL to a video, audio, or image file."),
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
      .describe(
        "Workspace-relative path where the full result JSON is written. You choose it (e.g. `av-tasks/<id>/analysis/clip.json`).",
      ),
    want_json: z
      .boolean()
      .optional()
      .describe(
        "Ask the model to return strict JSON. Describe the desired fields in `instruction`; parsed JSON is written into the result file, not returned inline.",
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

interface AnalyzeMediaData {
  source: MediaSource;
  kind: string;
  model: string;
  outPath: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export const analyzeMediaTool: RuntimeTool<AnalyzeMediaArgs, AnalyzeMediaData> = {
  name: "analyze_media",
  description:
    "Analyze a video/audio/image file or public URL with a multimodal model. Use for event detection with timestamps, speaker analysis, emotion recognition, and multimodal summaries. Writes the full result (model text + parsed JSON) to `out_path` and returns a short summary; read `out_path` for the complete output.",
  inputSchema: analyzeMediaArgsSchema,
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

      const source = toMediaSource(args, ctx.policy.resolveReadPath.bind(ctx.policy));
      const result = await callOmni({
        config: multimodal,
        source,
        instruction: args.instruction,
        jsonMode: args.want_json === true,
        signal: ctx.signal,
      });
      const envelope = {
        source,
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
          source,
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

function toMediaSource(args: AnalyzeMediaArgs, resolveReadPath: (path: string) => string): MediaSource {
  if (args.path !== undefined) {
    return { type: "file", path: resolveReadPath(args.path) };
  }
  if (args.url !== undefined && args.kind !== undefined) {
    if (args.kind === "audio") {
      if (args.format === undefined) {
        throw new RuntimeError({
          code: "INVALID_ARGS",
          message: "format is required for audio URL inputs.",
        });
      }
      return { type: "url", url: args.url, kind: "audio", format: args.format.toLowerCase() };
    }
    return { type: "url", url: args.url, kind: args.kind };
  }
  throw new RuntimeError({
    code: "INVALID_ARGS",
    message: "Provide exactly one of path or url.",
  });
}
