import type { ZodError } from "zod";

import { toRuntimeErrorShape } from "../runtime/errors.js";
import type { ToolCall } from "../runtime/types.js";
import { activateSkillTool } from "./activate-skill.js";
import { analyzeMediaTool } from "./analyze-media.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { probeMediaTool } from "./probe-media.js";
import { readTool } from "./read.js";
import type { RuntimeTool, ToolContext, ToolExecutionResult } from "./types.js";
import { writeTool } from "./write.js";

function formatZodError(error: ZodError): string {
  const issues = error.issues ?? [];
  if (issues.length === 0) {
    return "Invalid tool arguments";
  }

  return issues
    .map((issue) => {
      const fieldPath = issue.path?.length ? issue.path.join(".") : "<root>";
      return `${fieldPath}: ${issue.message}`;
    })
    .join("; ");
}

function normalizeStrictModeNulls(value: unknown): unknown {
  if (value === null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeStrictModeNulls);
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, normalizeStrictModeNulls(entryValue)]),
    );
  }

  return value;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RuntimeTool>();

  constructor(tools: RuntimeTool[]) {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  list(): RuntimeTool[] {
    return [...this.tools.values()];
  }

  async execute(toolCall: ToolCall, ctx: ToolContext) {
    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      return {
        ok: false,
        content: `Unknown tool: ${toolCall.name}`,
        error: {
          code: "INVALID_ARGS",
          message: `Unknown tool: ${toolCall.name}`,
        },
      } satisfies ToolExecutionResult;
    }

    const parsed = tool.inputSchema.safeParse(toolCall.arguments);
    let parsedArgs: unknown;
    if (parsed.success) {
      parsedArgs = parsed.data;
    } else {
      const normalizedParsed = tool.inputSchema.safeParse(normalizeStrictModeNulls(toolCall.arguments));
      if (!normalizedParsed.success) {
        const message = formatZodError(parsed.error);
        return {
          ok: false,
          content: message,
          error: {
            code: "INVALID_ARGS",
            message,
          },
        } satisfies ToolExecutionResult;
      }
      parsedArgs = normalizedParsed.data;
    }

    if (ctx.signal.aborted) {
      return {
        ok: false,
        content: `Tool ${tool.name} was cancelled before execution`,
        error: {
          code: "RUN_ABORTED",
          message: `Tool ${tool.name} was cancelled before execution`,
          retriable: true,
        },
      } satisfies ToolExecutionResult;
    }

    const controller = new AbortController();
    const handleAbort = () => controller.abort();
    ctx.signal.addEventListener("abort", handleAbort, { once: true });

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<ToolExecutionResult>((resolve) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        resolve({
          ok: false,
          content: `Tool ${tool.name} timed out after ${ctx.config.toolTimeoutMs}ms`,
          error: {
            code: "TOOL_TIMEOUT",
            message: `Tool ${tool.name} timed out after ${ctx.config.toolTimeoutMs}ms`,
            retriable: true,
          },
        });
      }, ctx.config.toolTimeoutMs);
    });

    const executionPromise: Promise<ToolExecutionResult> = tool
      .execute(parsedArgs, {
        ...ctx,
        signal: controller.signal,
      })
      .catch((error) => ({
        ok: false,
        content: error instanceof Error ? error.message : "Tool execution failed",
        error: toRuntimeErrorShape(error, "INTERNAL_ERROR"),
      }) satisfies ToolExecutionResult);

    try {
      return await Promise.race([executionPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      ctx.signal.removeEventListener("abort", handleAbort);
    }
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry([readTool, writeTool, editTool, bashTool, activateSkillTool, probeMediaTool, analyzeMediaTool]);
}
