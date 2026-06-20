import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 50 * 1024 * 1024;

function ffmpegBin(): string {
  return process.env.MINI_AGENT_FFMPEG_BIN ?? "ffmpeg";
}

function ffprobeBin(): string {
  return process.env.MINI_AGENT_FFPROBE_BIN ?? "ffprobe";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function assertLocalFile(file: string): void {
  if (file.startsWith("-") || /^[a-z][a-z0-9+.-]*:/i.test(file)) throw new Error("ffmpeg only accepts local file paths");
}

async function binaryWorks(bin: string): Promise<boolean> {
  try {
    await execFileAsync(bin, ["-version"], { timeout: 5_000, maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

export async function ffmpegAvailable(): Promise<boolean> {
  return (await binaryWorks(ffmpegBin())) && (await binaryWorks(ffprobeBin()));
}

export async function probeDuration(file: string): Promise<number> {
  assertLocalFile(file);
  let stdout: string | Buffer;
  try {
    ({ stdout } = await execFileAsync(ffprobeBin(), ["-v", "quiet", "-print_format", "json", "-show_streams", "-protocol_whitelist", "file", file], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      killSignal: "SIGKILL",
    }));
  } catch (error) {
    throw new Error(`ffprobe duration failed: ${errorMessage(error)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(String(stdout));
  } catch (error) {
    throw new Error(`ffprobe duration output is not JSON: ${errorMessage(error)}`);
  }
  const streams = (json as { streams?: unknown }).streams;
  if (!Array.isArray(streams)) throw new Error("ffprobe duration output missing streams array");
  const durations = streams
    .map((stream) => Number((stream as { duration?: unknown }).duration))
    .filter((duration) => Number.isFinite(duration) && duration > 0);
  const duration = Math.max(...durations);
  if (!Number.isFinite(duration)) throw new Error("ffprobe duration output missing stream duration");
  return duration;
}

export function parseSceneTimestamps(stderr: string): number[] {
  const found = new Set<number>();
  for (const match of stderr.matchAll(/\bpts_time:([0-9]+(?:\.[0-9]+)?)/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) found.add(value);
  }
  return [...found].sort((a, b) => a - b);
}

export function buildShotRanges(timestamps: number[], duration: number): [number, number][] {
  const end = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const cuts = [0, ...timestamps.filter((t) => Number.isFinite(t) && t > 0 && t < end), end];
  const unique = [...new Set(cuts)].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (let i = 0; i < unique.length - 1; i++) ranges.push([unique[i], unique[i + 1]]);
  return ranges.length > 0 ? ranges : [[0, end]];
}

function runFfmpeg(args: string[], captureStdout: boolean): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("ffmpeg timed out"));
    }, TIMEOUT_MS);

    function addChunk(chunks: Buffer[], chunk: Buffer, total: number): number {
      const next = total + chunk.length;
      if (next > MAX_BUFFER && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error("ffmpeg output exceeded maxBuffer"));
        return next;
      }
      chunks.push(chunk);
      return next;
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (!captureStdout) return;
      stdoutBytes = addChunk(stdoutChunks, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderrBytes = addChunk(stderrChunks, chunk, stderrBytes);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        reject(new Error(`ffmpeg failed (${signal ?? code}): ${stderr}`));
        return;
      }
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr });
    });
  });
}

export function buildDetectShotsArgs(file: string): string[] {
  return ["-nostdin", "-protocol_whitelist", "file,pipe", "-i", file, "-vf", "select='gt(scene,0.3)',showinfo", "-f", "null", "-an", "-"];
}

export function buildExtractFrameArgs(file: string, t: number): string[] {
  return ["-nostdin", "-protocol_whitelist", "file,pipe", "-ss", String(t), "-i", file, "-frames:v", "1", "-f", "image2", "-c:v", "png", "pipe:1"];
}

export function buildExtractAudioArgs(file: string): string[] {
  return ["-nostdin", "-protocol_whitelist", "file,pipe", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"];
}

export async function detectShots(file: string, duration: number): Promise<[number, number][]> {
  assertLocalFile(file);
  // TODO TransNetV2: replace select filter with TransNetV2 shot detector.
  const { stderr } = await runFfmpeg(buildDetectShotsArgs(file), false);
  return buildShotRanges(parseSceneTimestamps(stderr), duration);
}

export async function extractFrame(file: string, t: number): Promise<Buffer> {
  assertLocalFile(file);
  const { stdout } = await runFfmpeg(buildExtractFrameArgs(file, t), true);
  return stdout;
}

export async function extractAudioWav(file: string): Promise<Buffer> {
  assertLocalFile(file);
  const { stdout } = await runFfmpeg(buildExtractAudioArgs(file), true);
  return stdout;
}
