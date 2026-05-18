import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createPolicyEngine } from "../../src/runtime/policy.js";
import { createDefaultToolRegistry, ToolRegistry } from "../../src/tools/index.js";
import { getToolJsonSchema, type RuntimeTool, type ToolContext } from "../../src/tools/types.js";

function createContext(): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    sessionId: "sess_test",
    runId: "run_test",
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
        inputSchema: z.object({ name: z.string() }).strict(),
        async execute() {
          return {
            ok: true,
            content: "should not run",
            meta: { skipped: true },
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

  test("returns INVALID_ARGS when unknown fields are supplied (strict schema)", async () => {
    let executed = false;
    const registry = new ToolRegistry([
      {
        name: "demo",
        description: "demo",
        inputSchema: z.object({ name: z.string() }).strict(),
        async execute() {
          executed = true;
          return {
            ok: true,
            content: "should not run",
          };
        },
      } satisfies RuntimeTool,
    ]);

    const result = await registry.execute(
      {
        id: "call_demo_extra",
        name: "demo",
        arguments: { name: "ok", extra: "nope" },
      },
      createContext(),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "INVALID_ARGS" });
    expect(executed).toBe(false);
  });

  test("returns TOOL_TIMEOUT when a tool exceeds the runtime timeout budget", async () => {
    let aborted = false;
    const registry = new ToolRegistry([
      {
        name: "slow",
        description: "slow",
        inputSchema: z.object({}).strict(),
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

  test("getToolJsonSchema derives OpenAI strict-compatible JSON schemas for every default tool", () => {
    const registry = createDefaultToolRegistry();
    const tools = registry.list();
    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      const schema = getToolJsonSchema(tool);
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      const properties = schema.properties as Record<string, unknown>;
      const required = schema.required as string[];
      expect(Array.isArray(required)).toBe(true);
      const propertyNames = Object.keys(properties ?? {});
      // OpenAI strict mode requires every declared property to be in `required`.
      expect([...required].sort()).toEqual([...propertyNames].sort());
    }
  });

  test("does not execute tools when the runtime signal is already aborted", async () => {
    let executed = false;
    const registry = new ToolRegistry([
      {
        name: "noop",
        description: "noop",
        inputSchema: z.object({}).strict(),
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
      code: "RUN_ABORTED",
    });
    expect(executed).toBe(false);
  });
});
