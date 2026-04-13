import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

import { RuntimeError, toRuntimeErrorShape } from "../runtime/errors.js";
import type { RuntimeTool } from "./types.js";

interface BashArgs {
  command: string;
  cwd?: string;
  timeout_ms?: number;
}

interface BashData {
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  logPath: string;
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

export const bashTool: RuntimeTool<BashArgs, BashData> = {
  name: "bash",
  description: "Execute a shell command inside the workspace.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      timeout_ms: { type: "number" },
    },
    required: ["command"],
  },
  async execute(args, ctx) {
    const cwd = ctx.policy.resolveExecCwd(args.cwd ?? ".");
    const timeoutMs = Math.max(1, Math.min(args.timeout_ms ?? ctx.config.bashTimeoutMs, ctx.config.bashTimeoutMs));
    const artifactDir = path.join(ctx.workspaceRoot, ".mini-agent", "artifacts", "bash");
    const relativeLogPath = path.join(".mini-agent", "artifacts", "bash", `${ctx.toolCallId}.log`);
    const absoluteLogPath = path.join(ctx.workspaceRoot, relativeLogPath);

    await mkdir(artifactDir, { recursive: true });
    const logStream = createWriteStream(absoluteLogPath, { encoding: "utf8" });

    let stdout = "";
    let stderr = "";
    let combined = "";
    let timedOut = false;
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
        const abortHandler = () => terminateProcessTree(child.pid);

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
        artifacts: [
          {
            type: "log",
            path: relativeLogPath,
            description: "Full bash output log",
          },
        ],
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
        artifacts: [
          {
            type: "log",
            path: relativeLogPath,
            description: "Full bash output log",
          },
        ],
      };
    }
  },
};
