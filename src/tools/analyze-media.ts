import { z } from "zod";

import { RuntimeError, toRuntimeErrorShape } from "../runtime/errors.js";
import { callOmni } from "../model/multimodal.js";
import type { RuntimeTool } from "./types.js";

const analyzeMediaArgsSchema = z
  .object({
    path: z.string().describe("Path to a video, audio, or image file in the workspace."),
    instruction: z
      .string()
      .describe(
        "What to analyze, e.g. 'List key events with MM:SS timestamps' or 'Identify speakers and their emotion at each turn'.",
      ),
    want_json: z
      .boolean()
      .optional()
      .describe("Ask the model to return strict JSON. Describe the desired fields in `instruction`."),
  })
  .strict();

type AnalyzeMediaArgs = z.infer<typeof analyzeMediaArgsSchema>;

interface AnalyzeMediaData {
  path: string;
  kind: string;
  model: string;
  json?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export const analyzeMediaTool: RuntimeTool<AnalyzeMediaArgs, AnalyzeMediaData> = {
  name: "analyze_media",
  description:
    "Analyze a video/audio/image file with a multimodal model. Use for event detection with timestamps, speaker analysis, emotion recognition, and multimodal summaries. Returns the model's text (or JSON when want_json is set).",
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

      const filePath = ctx.policy.resolveReadPath(args.path);
      const result = await callOmni({
        config: multimodal,
        mediaPath: filePath,
        instruction: args.instruction,
        jsonMode: args.want_json === true,
        signal: ctx.signal,
      });

      return {
        ok: true,
        content: result.text,
        meta: {
          path: filePath,
          kind: result.kind,
          model: result.model,
          json: result.json,
          usage: result.usage,
        },
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
