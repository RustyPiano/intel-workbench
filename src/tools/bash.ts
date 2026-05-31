import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fg from "fast-glob";
import { z } from "zod";

import { RuntimeError, toRuntimeErrorShape } from "../runtime/errors.js";
import type { RuntimeTool, ToolArtifact } from "./types.js";

const bashArgsSchema = z
  .object({
    command: z.string(),
    cwd: z.string().optional(),
    timeout_ms: z.number().optional(),
    track_artifacts: z.boolean().optional(),
  })
  .strict();

type BashArgs = z.infer<typeof bashArgsSchema>;

interface BashData {
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  logPath: string;
}

// A reference to a secret .env file (.env, .env.local, .env.bak, …) but not the
// safe-to-read .env.example / .env.sample / .env.template templates.
const SECRET_ENV_FILE_PATTERN = /(^|[\s"'`|;&()<>/])\.env(?:\.(?!example(?:$|[\s"'`|;&()<>])|sample(?:$|[\s"'`|;&()<>])|template(?:$|[\s"'`|;&()<>]))[\w.-]+)?(?=$|[\s"'`|;&()<>])/u;
// Commands that print file contents to stdout — the path by which a secret file
// would reach the model's context. Heuristic by design: copying/moving/deleting
// a .env (which does not expose it to the model) is intentionally not blocked.
const SECRET_FILE_READER_PATTERN =
  /(^|[\s;&|(])(?:cat|tac|nl|less|more|head|tail|grep|egrep|fgrep|rg|ag|strings|od|xxd|hexdump|bat|sed|awk|cut|base64|openssl|source|\.)(?=\s)/u;
// `printenv` only ever prints, so block it outright. Bare `env` (no command to
// exec) dumps the whole environment — block `env`, `env | …`, `env > f` — but
// allow the common `env VAR=value command` idiom, which sets vars and execs.
const ENV_DUMP_COMMAND_PATTERN = /(^|[;&|]\s*)(?:printenv\b|env(?=\s*($|[|;&><])))/u;

type WorkspaceSnapshot = Map<string, string>;

const SNAPSHOT_IGNORE = [
  ".mini-agent/**",
  "node_modules/**",
  ".git/**",
  "dist/**",
  "build/**",
  ".next/**",
  ".cache/**",
  ".turbo/**",
  "coverage/**",
  ".venv/**",
  ".pytest_cache/**",
  "**/*.log",
];

async function snapshotWorkspaceFiles(workspaceRoot: string): Promise<WorkspaceSnapshot> {
  const filePaths = await fg(["**/*"], {
    cwd: workspaceRoot,
    onlyFiles: true,
    dot: true,
    ignore: SNAPSHOT_IGNORE,
  });

  const snapshot = new Map<string, string>();
  await Promise.all(
    filePaths.map(async (filePath) => {
      const fileStat = await stat(path.join(workspaceRoot, filePath));
      snapshot.set(filePath, `${fileStat.size}:${fileStat.mtimeMs}`);
    }),
  );
  return snapshot;
}

function collectChangedFiles(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
  return [...after.entries()]
    .filter(([filePath, fingerprint]) => before.get(filePath) !== fingerprint)
    .map(([filePath]) => filePath)
    .sort((left, right) => left.localeCompare(right));
}

function truncateTail(input: string, maxBytes: number): string {
  const buffer = Buffer.from(input, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return input;
  }

  let start = buffer.byteLength - maxBytes;
  while (start < buffer.byteLength && (buffer[start] & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }

  return buffer.subarray(start).toString("utf8");
}

function appendTail(current: string, chunk: string, maxBytes: number): string {
  return truncateTail(current + chunk, maxBytes);
}

async function closeStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  if (stream.writableFinished || stream.destroyed) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    stream.once("finish", resolve);
    stream.once("error", reject);
    stream.end();
  });
}

function terminateProcessTree(pid: number | undefined): void {
  if (!pid) {
    return;
  }

  try {
    if (process.platform === "win32") {
      process.kill(pid, "SIGTERM");
      return;
    }

    process.kill(-pid, "SIGTERM");
  } catch {
    // The process may already be gone.
  }
}

function assertCommandDoesNotExposeSecrets(command: string): void {
  const dumpsEnvironment = ENV_DUMP_COMMAND_PATTERN.test(command);
  const readsSecretFile = SECRET_ENV_FILE_PATTERN.test(command) && SECRET_FILE_READER_PATTERN.test(command);
  if (dumpsEnvironment || readsSecretFile) {
    throw new RuntimeError({
      code: "PATH_NOT_ALLOWED",
      message:
        "Command appears to read or print secret configuration. Use redacted diagnostics such as `npm run dev -- doctor`, and describe variable names without exposing values.",
    });
  }
}

export const bashTool: RuntimeTool<BashArgs, BashData> = {
  name: "bash",
  description:
    "Execute a shell command inside the workspace. Do not use this to print environment variables or read secret files such as .env, API keys, tokens, or credentials; use redacted diagnostics such as `npm run dev -- doctor` for configuration status.",
  inputSchema: bashArgsSchema,
  async execute(args, ctx) {
    try {
      assertCommandDoesNotExposeSecrets(args.command);
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : "Command blocked",
        error: toRuntimeErrorShape(error, "PATH_NOT_ALLOWED"),
      };
    }

    const cwd = ctx.policy.resolveExecCwd(args.cwd ?? ".");
    const timeoutMs = Math.max(1, Math.min(args.timeout_ms ?? ctx.config.bashTimeoutMs, ctx.config.bashTimeoutMs));
    const artifactDir = path.join(ctx.workspaceRoot, ".mini-agent", "runs", ctx.runId, "artifacts", "bash");
    const relativeLogPath = path.join(".mini-agent", "runs", ctx.runId, "artifacts", "bash", `${ctx.toolCallId}.log`);
    const absoluteLogPath = path.join(ctx.workspaceRoot, relativeLogPath);
    const trackArtifacts = args.track_artifacts === true;
    const filesBefore = trackArtifacts ? await snapshotWorkspaceFiles(ctx.workspaceRoot) : null;

    await mkdir(artifactDir, { recursive: true });
    const logStream = createWriteStream(absoluteLogPath, { encoding: "utf8" });

    let stdout = "";
    let stderr = "";
    let combined = "";
    let timedOut = false;
    let aborted = false;
    let logClosed = false;
    let logStreamError: Error | null = null;

    logStream.on("error", (error) => {
      logStreamError = error;
    });

    const appendOutput = (text: string, target: "stdout" | "stderr") => {
      combined = appendTail(combined, text, ctx.config.maxBashOutputBytes);
      if (target === "stdout") {
        stdout = appendTail(stdout, text, ctx.config.maxBashOutputBytes);
      } else {
        stderr = appendTail(stderr, text, ctx.config.maxBashOutputBytes);
      }

      if (!logStreamError) {
        logStream.write(text);
      }
      ctx.onUpdate?.(text);
    };

    const finalizeLog = async () => {
      if (logClosed) {
        if (logStreamError) {
          throw logStreamError;
        }
        return;
      }

      logClosed = true;
      if (logStreamError) {
        logStream.destroy();
        throw logStreamError;
      }
      await closeStream(logStream);
      if (logStreamError) {
        throw logStreamError;
      }
    };

    const buildArtifacts = async (): Promise<ToolArtifact[]> => {
      const artifacts: ToolArtifact[] = [
        {
          type: "log",
          path: relativeLogPath,
          description: "Full bash output log",
        },
      ];

      if (!trackArtifacts || !filesBefore) {
        return artifacts;
      }

      const filesAfter = await snapshotWorkspaceFiles(ctx.workspaceRoot);
      const createdFiles = collectChangedFiles(filesBefore, filesAfter);
      for (const filePath of createdFiles) {
        artifacts.push({
          type: "file",
          path: filePath,
          description: "File created by bash command",
        });
      }
      return artifacts;
    };

    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(args.command, {
          cwd,
          shell: true,
          detached: process.platform !== "win32",
        });

        const timer = setTimeout(() => {
          timedOut = true;
          terminateProcessTree(child.pid);
        }, timeoutMs);
        const abortHandler = () => {
          aborted = true;
          terminateProcessTree(child.pid);
        };

        ctx.signal.addEventListener("abort", abortHandler, { once: true });

        child.stdout.on("data", (chunk: Buffer | string) => {
          appendOutput(chunk.toString(), "stdout");
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
          appendOutput(chunk.toString(), "stderr");
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", abortHandler);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", abortHandler);
          resolve(code);
        });
      });

      await finalizeLog();

      if (timedOut) {
        throw new RuntimeError({
          code: "TOOL_TIMEOUT",
          message: `Command timed out after ${timeoutMs}ms`,
          retriable: true,
        });
      }

      if (aborted || ctx.signal.aborted) {
        throw new RuntimeError({
          code: "RUN_ABORTED",
          message: "Command aborted by signal",
          retriable: true,
        });
      }

      if (exitCode !== 0) {
        throw new RuntimeError({
          code: "PROCESS_EXIT_NONZERO",
          message: `Command exited with code ${exitCode}`,
          details: { exitCode },
        });
      }

      return {
        ok: true,
        content: combined,
        meta: {
          exitCode,
          stdoutTail: stdout,
          stderrTail: stderr,
          logPath: relativeLogPath,
        },
        artifacts: await buildArtifacts(),
      };
    } catch (error) {
      await finalizeLog();

      return {
        ok: false,
        content: error instanceof Error ? error.message : "Failed to execute command",
        meta: {
          exitCode: error instanceof RuntimeError && typeof error.details?.exitCode === "number" ? (error.details.exitCode as number) : null,
          stdoutTail: stdout,
          stderrTail: stderr,
          logPath: relativeLogPath,
        },
        error: toRuntimeErrorShape(error, timedOut ? "TOOL_TIMEOUT" : "INTERNAL_ERROR"),
        artifacts: await buildArtifacts(),
      };
    }
  },
};
