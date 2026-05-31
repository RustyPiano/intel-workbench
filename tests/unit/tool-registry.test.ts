import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createPolicyEngine } from "../../src/runtime/policy.js";
import { createDefaultToolRegistry, ToolRegistry } from "../../src/tools/index.js";
import { getToolJsonSchema, type RuntimeTool, type ToolContext, type ToolRuntimeConfig } from "../../src/tools/types.js";

function createContext(config?: Partial<ToolRuntimeConfig>): ToolContext {
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
      ...config,
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

  test("uses the multimodal timeout budget for analyze_media", async () => {
    let aborted = false;
    const registry = new ToolRegistry([
      {
        name: "analyze_media",
        description: "slow multimodal fixture",
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
        id: "call_slow_mm",
        name: "analyze_media",
        arguments: {},
      },
      createContext({ toolTimeoutMs: 25, mmTimeoutMs: 75 }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: "TOOL_TIMEOUT",
      message: "Tool analyze_media timed out after 75ms",
    });
    expect(aborted).toBe(true);
  });

  test("uses the ASR timeout budget for analyze_audio", async () => {
    let aborted = false;
    const registry = new ToolRegistry([
      {
        name: "analyze_audio",
        description: "slow ASR fixture",
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
        id: "call_slow_asr",
        name: "analyze_audio",
        arguments: {},
      },
      createContext({ toolTimeoutMs: 25, asrTimeoutMs: 75 }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: "TOOL_TIMEOUT",
      message: "Tool analyze_audio timed out after 75ms",
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

  test("getToolJsonSchema widens optional fields to accept null", () => {
    const tool: RuntimeTool = {
      name: "widening_probe",
      description: "fixture",
      inputSchema: z
        .object({
          mandatory: z.string(),
          maybe: z.string().optional(),
          flag: z.boolean().optional(),
        })
        .strict(),
      async execute() {
        return { ok: true, content: "" };
      },
    };

    const schema = getToolJsonSchema(tool);
    const properties = schema.properties as Record<string, { type: unknown }>;

    // Mandatory field keeps a single type — no null widening.
    expect(properties.mandatory.type).toBe("string");

    // Optional fields must accept `null` so OpenAI strict mode treats them as
    // explicitly-absent rather than missing.
    const widened = (value: unknown): boolean =>
      Array.isArray(value) && (value as string[]).includes("null");
    expect(widened(properties.maybe.type)).toBe(true);
    expect(widened(properties.flag.type)).toBe(true);

    // Every declared property is still in `required`.
    expect([...(schema.required as string[])].sort()).toEqual(["flag", "mandatory", "maybe"]);
  });

  test("getToolJsonSchema exposes analyze_media nullable source fields for strict mode", () => {
    const registry = createDefaultToolRegistry();
    const analyzeMedia = registry.list().find((tool) => tool.name === "analyze_media");
    expect(analyzeMedia).toBeDefined();

    const schema = getToolJsonSchema(analyzeMedia!);
    const properties = schema.properties as Record<string, { type: unknown }>;
    const required = schema.required as string[];
    expect([...required].sort()).toEqual(
      ["format", "instruction", "kind", "out_path", "path", "url", "want_json"].sort(),
    );

    const acceptsNull = (value: unknown): boolean => Array.isArray(value) && value.includes("null");
    expect(acceptsNull(properties.path.type)).toBe(true);
    expect(acceptsNull(properties.url.type)).toBe(true);
    expect(acceptsNull(properties.kind.type)).toBe(true);
    expect(acceptsNull(properties.format.type)).toBe(true);
    expect(acceptsNull(properties.want_json.type)).toBe(true);
    expect(acceptsNull(properties.out_path.type)).toBe(true);
    expect(properties.instruction.type).toBe("string");
  });

  test("getToolJsonSchema exposes analyze_audio required and nullable optional fields for strict mode", () => {
    const registry = createDefaultToolRegistry();
    const analyzeAudio = registry.list().find((tool) => tool.name === "analyze_audio");
    expect(analyzeAudio).toBeDefined();

    const schema = getToolJsonSchema(analyzeAudio!);
    const properties = schema.properties as Record<string, { type: unknown }>;
    const required = schema.required as string[];
    expect([...required].sort()).toEqual(
      ["advanced", "emotion", "engine", "format", "hotwords", "language", "out_path", "path", "speaker", "url"].sort(),
    );

    const acceptsNull = (value: unknown): boolean => Array.isArray(value) && value.includes("null");
    expect(acceptsNull(properties.url.type)).toBe(true);
    expect(acceptsNull(properties.path.type)).toBe(true);
    expect(acceptsNull(properties.format.type)).toBe(true);
    expect(acceptsNull(properties.out_path.type)).toBe(true);
    expect(acceptsNull(properties.language.type)).toBe(true);
    expect(acceptsNull(properties.hotwords.type)).toBe(true);
    expect(acceptsNull(properties.advanced.type)).toBe(true);
  });

  test("normalizes strict-mode null optional fields before executing tools", async () => {
    let receivedArgs: unknown;
    const registry = new ToolRegistry([
      {
        name: "nullable_optional_probe",
        description: "fixture",
        inputSchema: z
          .object({
            mandatory: z.string(),
            maybe: z.string().optional(),
            flag: z.boolean().optional(),
          })
          .strict(),
        async execute(args) {
          receivedArgs = args;
          return { ok: true, content: "executed" };
        },
      } satisfies RuntimeTool,
    ]);

    const result = await registry.execute(
      {
        id: "call_nullable_optional",
        name: "nullable_optional_probe",
        arguments: {
          mandatory: "ok",
          maybe: null,
          flag: null,
        },
      },
      createContext(),
    );

    expect(result.ok).toBe(true);
    expect(receivedArgs).toEqual({
      mandatory: "ok",
      maybe: undefined,
      flag: undefined,
    });
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
