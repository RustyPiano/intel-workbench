import { spawn } from "node:child_process";
import { z } from "zod";

import { RuntimeError, toRuntimeErrorShape } from "../runtime/errors.js";
import type { RuntimeTool } from "./types.js";

const probeMediaArgsSchema = z
  .object({
    path: z.string().describe("Path to a media file (video or audio) in the workspace."),
  })
  .strict();

type ProbeMediaArgs = z.infer<typeof probeMediaArgsSchema>;

interface StreamSummary {
  index: number;
  type: string;
  codec?: string;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
}

interface ProbeMediaData {
  path: string;
  durationSeconds: number | null;
  formatName?: string;
  sizeBytes: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  streams: StreamSummary[];
}

interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  sample_rate?: string;
  channels?: number;
}

interface FfprobeOutput {
  format?: { duration?: string; format_name?: string; size?: string };
  streams?: FfprobeStream[];
}

function runFfprobe(filePath: string, signal: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { shell: false },
    );

    let stdout = "";
    let stderr = "";
    const abortHandler = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abortHandler, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      signal.removeEventListener("abort", abortHandler);
      if (error.code === "ENOENT") {
        reject(
          new RuntimeError({
            code: "INTERNAL_ERROR",
            message: "ffprobe not found. Install ffmpeg (which provides ffprobe) to use probe_media.",
          }),
        );
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", abortHandler);
      resolve({ code, stdout, stderr });
    });
  });
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export const probeMediaTool: RuntimeTool<ProbeMediaArgs, ProbeMediaData> = {
  name: "probe_media",
  description:
    "Inspect a media file with ffprobe: duration, container, and video/audio streams. Use this before analyze_media to decide whether long media needs to be split into chunks.",
  inputSchema: probeMediaArgsSchema,
  async execute(args, ctx) {
    try {
      const filePath = ctx.policy.resolveReadPath(args.path);
      const { code, stdout, stderr } = await runFfprobe(filePath, ctx.signal);

      if (code !== 0) {
        throw new RuntimeError({
          code: "PROCESS_EXIT_NONZERO",
          message: `ffprobe exited with code ${code}: ${stderr.trim() || "unknown error"}`,
          details: { exitCode: code },
        });
      }

      const parsed = JSON.parse(stdout) as FfprobeOutput;
      const streams: StreamSummary[] = (parsed.streams ?? []).map((stream, index) => ({
        index: stream.index ?? index,
        type: stream.codec_type ?? "unknown",
        codec: stream.codec_name,
        width: stream.width,
        height: stream.height,
        sampleRate: toNumber(stream.sample_rate) ?? undefined,
        channels: stream.channels,
      }));

      const data: ProbeMediaData = {
        path: filePath,
        durationSeconds: toNumber(parsed.format?.duration),
        formatName: parsed.format?.format_name,
        sizeBytes: toNumber(parsed.format?.size),
        hasVideo: streams.some((stream) => stream.type === "video"),
        hasAudio: streams.some((stream) => stream.type === "audio"),
        streams,
      };

      const durationText = data.durationSeconds === null ? "unknown" : `${data.durationSeconds.toFixed(1)}s`;
      const summary = [
        `path: ${data.path}`,
        `duration: ${durationText}`,
        `container: ${data.formatName ?? "unknown"}`,
        `video: ${data.hasVideo ? "yes" : "no"}`,
        `audio: ${data.hasAudio ? "yes" : "no"}`,
        `streams: ${streams
          .map((stream) => `${stream.type}/${stream.codec ?? "?"}${stream.type === "video" && stream.width ? ` ${stream.width}x${stream.height}` : ""}`)
          .join(", ")}`,
      ].join("\n");

      return {
        ok: true,
        content: summary,
        meta: data,
      };
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : "Failed to probe media",
        error: toRuntimeErrorShape(error, "INTERNAL_ERROR"),
      };
    }
  },
};
