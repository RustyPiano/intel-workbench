import { describe, expect, test } from "vitest";

import { createPolicyEngine } from "../../src/runtime/policy.js";
import { ToolRegistry } from "../../src/tools/index.js";
import type { RuntimeTool, ToolContext } from "../../src/tools/types.js";

function createContext(): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    sessionId: "sess_test",
    toolCallId: "call_test",
    signal: new AbortController().signal,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    policy: createPolicyEngine({ workspaceRoot: process.cwd() }),
    config: {
      toolTimeoutMs: 25,
      bashTimeoutMs: 120_000,
      maxBashOutputBytes: 64 * 1024,
      readMaxBytes: 256 * 1024,
    },
  };
}

function createAbortedContext(): ToolContext {
  const controller = new AbortController();
  controller.abort();
  return {
    ...createContext(),
    signal: controller.signal,
  };
}

describe("ToolRegistry", () => {
  test("returns INVALID_ARGS when a required field is missing", async () => {
    const registry = new ToolRegistry([
      {
        name: "demo",
        description: "demo",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
        async execute() {
          return {
            ok: true,
            content: "should not run",
          };
        },
      } satisfies RuntimeTool,
    ]);

    const result = await registry.execute(
      {
        id: "call_demo",
        name: "demo",
        arguments: {},
      },
      createContext(),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: "INVALID_ARGS",
    });
  });

  test("returns TOOL_TIMEOUT when a tool exceeds the runtime timeout budget", async () => {
    let aborted = false;
    const registry = new ToolRegistry([
      {
        name: "slow",
        description: "slow",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
        async execute(_args, ctx) {
          return new Promise((resolve) => {
            ctx.signal.addEventListener("abort", () => {
              aborted = true;
              resolve({
                ok: false,
                content: "aborted",
              });
            });
          });
        },
      } satisfies RuntimeTool,
    ]);

    const result = await registry.execute(
      {
        id: "call_slow",
        name: "slow",
        arguments: {},
      },
      createContext(),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: "TOOL_TIMEOUT",
    });
    expect(aborted).toBe(true);
  });

  test("does not execute tools when the runtime signal is already aborted", async () => {
    let executed = false;
    const registry = new ToolRegistry([
      {
        name: "noop",
        description: "noop",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
        async execute() {
          executed = true;
          return {
            ok: true,
            content: "unexpected",
          };
        },
      } satisfies RuntimeTool,
    ]);

    const result = await registry.execute(
      {
        id: "call_noop",
        name: "noop",
        arguments: {},
      },
      createAbortedContext(),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: "TOOL_TIMEOUT",
    });
    expect(executed).toBe(false);
  });
});
