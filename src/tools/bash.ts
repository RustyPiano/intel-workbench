import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

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

  return buffer.subarray(buffer.byteLength - maxBytes).toString("utf8");
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
    const timeoutMs = args.timeout_ms ?? ctx.config.bashTimeoutMs;
    const artifactDir = path.join(ctx.workspaceRoot, ".mini-agent", "artifacts", "bash");
    const relativeLogPath = path.join(".mini-agent", "artifacts", "bash", `${ctx.toolCallId}.log`);
    const absoluteLogPath = path.join(ctx.workspaceRoot, relativeLogPath);

    await mkdir(artifactDir, { recursive: true });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(args.command, {
          cwd,
          shell: true,
          signal: ctx.signal,
        });

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeoutMs);

        child.stdout.on("data", (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      const combinedLog = [stdout, stderr].filter(Boolean).join("");
      await writeFile(absoluteLogPath, combinedLog, "utf8");

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
        content: truncateTail(stdout || stderr, ctx.config.maxBashOutputBytes),
        data: {
          exitCode,
          stdoutTail: truncateTail(stdout, ctx.config.maxBashOutputBytes),
          stderrTail: truncateTail(stderr, ctx.config.maxBashOutputBytes),
          logPath: relativeLogPath,
        },
        artifacts: [
          {
            kind: "bash_log",
            path: relativeLogPath,
          },
        ],
      };
    } catch (error) {
      await writeFile(absoluteLogPath, [stdout, stderr].filter(Boolean).join(""), "utf8");

      return {
        ok: false,
        content: error instanceof Error ? error.message : "Failed to execute command",
        data: {
          exitCode: null,
          stdoutTail: truncateTail(stdout, ctx.config.maxBashOutputBytes),
          stderrTail: truncateTail(stderr, ctx.config.maxBashOutputBytes),
          logPath: relativeLogPath,
        },
        error: toRuntimeErrorShape(error, timedOut ? "TOOL_TIMEOUT" : "INTERNAL_ERROR"),
        artifacts: [
          {
            kind: "bash_log",
            path: relativeLogPath,
          },
        ],
      };
    }
  },
};
