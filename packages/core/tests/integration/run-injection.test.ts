import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { ScriptedModelAdapter } from "../../src/model/mock.js";
import type { GenerateInput, GenerateResult, ModelAdapter } from "../../src/model/types.js";
import { RuntimeAgent } from "../../src/runtime/agent.js";
import type { ToolExecutionResult, RuntimeTool } from "../../src/tools/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-run-injection-"));
  tempRoots.push(root);
  return root;
}

async function createAgent(modelAdapter: ModelAdapter): Promise<RuntimeAgent> {
  return RuntimeAgent.create({
    workspaceRoot: await createWorkspace(),
    runtimeVersion: "1.0.0",
    modelName: "mock",
    modelAdapter,
  });
}

function scriptedToolCall(name: string, args: Record<string, unknown>, id = `call_${name}`): GenerateResult {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id, name, arguments: args }],
    },
    stopReason: "tool_use",
  };
}

function scriptedFinal(content = "done"): GenerateResult {
  return {
    message: { role: "assistant", content },
    stopReason: "end_turn",
  };
}

function customTool(
  name: string,
  execute: RuntimeTool["execute"] = async () => ({ ok: true, content: `${name}:ok` }),
  inputSchema: RuntimeTool["inputSchema"] = z.object({}).passthrough(),
): RuntimeTool {
  return {
    name,
    description: `${name} fixture`,
    inputSchema,
    execute,
  };
}

describe("run-level tool injection", () => {
  test("baseTools empty creates an empty base registry while extraTools stay run-scoped", async () => {
    const model = new ScriptedModelAdapter([scriptedFinal("done")]);
    const agent = await RuntimeAgent.create({
      workspaceRoot: await createWorkspace(),
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: model,
      baseTools: [],
    });

    await agent.run("only custom", undefined, {
      extraTools: [customTool("custom_only")],
    });

    expect(agent.toolRegistry.list()).toHaveLength(0);
    expect(model.inputs[0]!.tools.map((tool) => tool.name)).toEqual(["custom_only"]);
  });

  test("run-level modelAdapter override is used instead of the agent adapter", async () => {
    let baseCalled = false;
    const base: ModelAdapter = {
      name: "base",
      async generate(): Promise<GenerateResult> {
        baseCalled = true;
        return scriptedFinal("base");
      },
    };
    const override = new ScriptedModelAdapter([scriptedFinal("override")]);
    const agent = await createAgent(base);

    const result = await agent.run("override model", undefined, { modelAdapter: override });

    expect(result.finalMessage.content).toBe("override");
    expect(baseCalled).toBe(false);
    expect(override.inputs).toHaveLength(1);
  });

  test("extraTools are advertised to the model and callable for the run", async () => {
    let ran = false;
    const model = new ScriptedModelAdapter([scriptedToolCall("custom_echo", { value: "hello" }), scriptedFinal()]);
    const agent = await createAgent(model);

    await agent.run("call custom", undefined, {
      extraTools: [
        customTool(
          "custom_echo",
          async (args) => {
            ran = true;
            return { ok: true, content: `echo:${JSON.stringify(args)}` };
          },
          z.object({ value: z.string() }).strict(),
        ),
      ],
    });

    expect(model.inputs[0]!.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["read", "custom_echo"]));
    expect(ran).toBe(true);
  });

  test("same-name extraTools reject the run while non-colliding extraTools still work", async () => {
    const conflicting = await createAgent(new ScriptedModelAdapter([scriptedFinal("unused")]));
    await expect(
      conflicting.run("conflict", undefined, {
        extraTools: [customTool("read")],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGS",
      message: "Duplicate tool name: read",
    });

    let ran = false;
    const model = new ScriptedModelAdapter([scriptedToolCall("custom_safe", {}), scriptedFinal()]);
    const agent = await createAgent(model);
    await agent.run("no conflict", undefined, {
      extraTools: [
        customTool("custom_safe", async () => {
          ran = true;
          return { ok: true, content: "safe" };
        }),
      ],
    });

    expect(ran).toBe(true);
  });

  test("toolMiddleware observes full tool arguments and full execution results in order", async () => {
    const fullArgs = {
      value: "hello",
      details: {
        secret: "not-previewed",
        values: ["a", "b", "c"],
      },
    };
    const fullContent = `full-result:${"x".repeat(2048)}`;
    const events: string[] = [];
    const model = new ScriptedModelAdapter([scriptedToolCall("custom_full", fullArgs), scriptedFinal()]);
    const agent = await createAgent(model);

    await agent.run("audit custom", undefined, {
      extraTools: [
        customTool(
          "custom_full",
          async (): Promise<ToolExecutionResult> => ({ ok: true, content: fullContent }),
          z
            .object({
              value: z.string(),
              details: z.object({ secret: z.string(), values: z.array(z.string()) }).strict(),
            })
            .strict(),
        ),
      ],
      toolMiddleware: async (toolCall, next) => {
        events.push(`intent:${toolCall.name}:${JSON.stringify(toolCall.arguments)}`);
        const result = await next();
        events.push(`result:${result.ok}:${result.content}`);
        return result;
      },
    });

    expect(events).toEqual([
      `intent:custom_full:${JSON.stringify(fullArgs)}`,
      `result:true:${fullContent}`,
    ]);
  });

  test("toolMiddleware errors reject send and journal an error entry", async () => {
    const model = new ScriptedModelAdapter([scriptedToolCall("custom_boom", {}), scriptedFinal("unused")]);
    const agent = await createAgent(model);
    const conversation = await agent.createConversation();

    await expect(
      conversation.send("middleware throws", undefined, {
        extraTools: [customTool("custom_boom")],
        toolMiddleware: async () => {
          throw new Error("audit write failed");
        },
      }),
    ).rejects.toThrow("audit write failed");

    const loaded = await agent.sessionStore.loadSession(conversation.sessionId);
    expect(
      loaded.entries.some(
        (entry) => entry.type === "error" && entry.error.message === "audit write failed",
      ),
    ).toBe(true);
  });

  test("plain middleware throws are journaled as INTERNAL_ERROR", async () => {
    const model = new ScriptedModelAdapter([scriptedToolCall("custom_boom", {}), scriptedFinal("unused")]);
    const agent = await createAgent(model);
    const conversation = await agent.createConversation();

    await expect(
      conversation.send("middleware throws", undefined, {
        extraTools: [customTool("custom_boom")],
        toolMiddleware: async () => {
          throw new Error("audit write failed");
        },
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "audit write failed",
    });

    const loaded = await agent.sessionStore.loadSession(conversation.sessionId);
    expect(
      loaded.entries.some(
        (entry) =>
          entry.type === "error" &&
          entry.error.code === "INTERNAL_ERROR" &&
          entry.error.message === "audit write failed",
      ),
    ).toBe(true);
  });

  test("middleware throw keeps the session resumable (no dangling tool_call)", async () => {
    const model = new ScriptedModelAdapter([scriptedToolCall("custom_boom", {}), scriptedFinal("after-failure")]);
    const agent = await createAgent(model);
    const conversation = await agent.createConversation();

    await expect(
      conversation.send("p1", undefined, {
        extraTools: [customTool("custom_boom")],
        toolMiddleware: async () => {
          throw new Error("audit write failed");
        },
      }),
    ).rejects.toThrow("audit write failed");

    await conversation.send("p2");

    const loaded = await agent.sessionStore.loadSession(conversation.sessionId, { mode: "strict" });
    expect(loaded.status).toBe("valid");
    expect(loaded.corrupted).toBe(false);
  });

  test("concurrent conversations keep per-run extraTools and middleware isolated", async () => {
    const capturedTools = new Map<string, string[][]>();
    let initialGenerateEntrants = 0;
    let releaseInitialGenerate: () => void = () => {};
    const bothRunsEnteredInitialGenerate = new Promise<void>((resolve) => {
      releaseInitialGenerate = resolve;
    });

    const model: ModelAdapter = {
      name: "isolated",
      async generate(input: GenerateInput): Promise<GenerateResult> {
        const prompt = input.messages.find((message) => message.role === "user")?.content ?? "unknown";
        const toolNames = input.tools.map((tool) => tool.name);
        capturedTools.set(prompt, [...(capturedTools.get(prompt) ?? []), toolNames]);

        if (!input.messages.some((message) => message.role === "tool")) {
          initialGenerateEntrants += 1;
          if (initialGenerateEntrants === 2) {
            releaseInitialGenerate();
          }
          await bothRunsEnteredInitialGenerate;

          const customName = toolNames.find((name) => name.startsWith("custom_")) ?? "missing_custom";
          return scriptedToolCall(customName, { prompt }, `call_${prompt}`);
        }

        return scriptedFinal(`done:${prompt}`);
      },
    };
    const agent = await createAgent(model);
    const conversationA = await agent.createConversation();
    const conversationB = await agent.createConversation();
    const middlewareA: string[] = [];
    const middlewareB: string[] = [];

    await Promise.all([
      conversationA.send("run A", undefined, {
        extraTools: [customTool("custom_a")],
        toolMiddleware: async (toolCall, next) => {
          middlewareA.push(toolCall.name);
          return next();
        },
      }),
      conversationB.send("run B", undefined, {
        extraTools: [customTool("custom_b")],
        toolMiddleware: async (toolCall, next) => {
          middlewareB.push(toolCall.name);
          return next();
        },
      }),
    ]);

    expect(capturedTools.get("run A")!.every((names) => names.includes("custom_a"))).toBe(true);
    expect(capturedTools.get("run A")!.every((names) => !names.includes("custom_b"))).toBe(true);
    expect(middlewareA).toEqual(["custom_a"]);

    expect(capturedTools.get("run B")!.every((names) => names.includes("custom_b"))).toBe(true);
    expect(capturedTools.get("run B")!.every((names) => !names.includes("custom_a"))).toBe(true);
    expect(middlewareB).toEqual(["custom_b"]);
  });

  test("finalize_answer fixture captures structured payload separately from final text", async () => {
    let captured: unknown = null;
    const finalizeAnswer = customTool(
      "finalize_answer",
      async (args) => {
        captured = args;
        return { ok: true, content: "captured" };
      },
      z
        .object({
          claims: z.array(z.object({ text: z.string(), cite_ids: z.array(z.string()) }).strict()),
        })
        .strict(),
    );
    const model = new ScriptedModelAdapter([
      scriptedToolCall("finalize_answer", { claims: [{ text: "x", cite_ids: ["c1"] }] }),
      scriptedFinal("done"),
    ]);
    const agent = await createAgent(model);

    const result = await agent.run("finalize", undefined, { extraTools: [finalizeAnswer] });

    expect(captured).toEqual({ claims: [{ text: "x", cite_ids: ["c1"] }] });
    expect(result.finalMessage.content).toBe("done");

    let negativeCaptured: unknown = null;
    const negative = await createAgent(new ScriptedModelAdapter([scriptedFinal("done")]));
    const negativeResult = await negative.run("no finalize", undefined, {
      extraTools: [
        customTool("finalize_answer", async (args) => {
          negativeCaptured = args;
          return { ok: true, content: "captured" };
        }),
      ],
    });

    expect(negativeCaptured).toBeNull();
    expect(negativeResult.finalMessage.content).toBe("done");
  });

  test("default run behavior advertises only the base tools and does not reuse middleware", async () => {
    let middlewareCalls = 0;
    const model = new ScriptedModelAdapter([
      scriptedToolCall("custom_once", {}),
      scriptedFinal("override"),
      scriptedFinal("default"),
    ]);
    const agent = await createAgent(model);

    await agent.run("override", undefined, {
      extraTools: [customTool("custom_once")],
      toolMiddleware: async (_toolCall, next) => {
        middlewareCalls += 1;
        return next();
      },
    });
    await agent.run("default");

    expect(model.inputs[2]!.tools).toHaveLength(8);
    expect(model.inputs[2]!.tools).toHaveLength(agent.toolRegistry.list().length);
    expect(model.inputs[2]!.tools.map((tool) => tool.name)).not.toContain("custom_once");
    expect(middlewareCalls).toBe(1);
  });
});
