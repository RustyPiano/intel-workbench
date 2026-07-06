import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { RuntimeAgent } from "../../src/runtime/agent.js";
import { SessionStore } from "../../src/runtime/session.js";
import { ScriptedModelAdapter } from "../../src/model/mock.js";
import { OpenAICompatibleModelAdapter } from "../../src/model/openai-compatible.js";

const tempRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-runtime-"));
  tempRoots.push(root);
  return root;
}

async function createIntelBulletinSkill(workspaceRoot: string) {
  const skillRoot = path.join(workspaceRoot, ".agents", "skills", "intel-bulletin");
  await mkdir(path.join(skillRoot, "scripts"), { recursive: true });
  await mkdir(path.join(skillRoot, "references"), { recursive: true });

  await writeFile(
    path.join(skillRoot, "SKILL.md"),
    `---
name: intel-bulletin
description: Build a bulletin from source notes.
compatibility: Requires Python 3.11+
allowed-tools: read write edit bash activate_skill
---

# Intel Bulletin

Use this skill to turn source notes into a formal report.
`,
  );

  await writeFile(
    path.join(skillRoot, "scripts", "render_report.py"),
    [
      "from pathlib import Path",
      "import sys",
      "",
      "source = Path(sys.argv[1]).read_text(encoding='utf-8')",
      "output = Path(sys.argv[2])",
      "output.write_text('REPORT\\n' + source, encoding='utf-8')",
    ].join("\n"),
    "utf8",
  );

  await writeFile(path.join(skillRoot, "references", "writing-guide.md"), "# guide\n", "utf8");
}

describe("RuntimeAgent", () => {
  test("executes a scripted read -> edit -> write loop and persists the session", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, "README.md"), "TODO\n", "utf8");

    const model = new ScriptedModelAdapter([
      {
        message: {
          role: "assistant",
          content: "I will inspect the file.",
          toolCalls: [{ id: "call_read", name: "read", arguments: { path: "README.md" } }],
        },
        stopReason: "tool_use",
      },
      {
        message: {
          role: "assistant",
          content: "I will update the file.",
          toolCalls: [
            {
              id: "call_edit",
              name: "edit",
              arguments: {
                path: "README.md",
                old_text: "TODO",
                new_text: "DONE",
              },
            },
          ],
        },
        stopReason: "tool_use",
      },
      {
        message: {
          role: "assistant",
          content: "I will write the report.",
          toolCalls: [
            {
              id: "call_write",
              name: "write",
              arguments: {
                path: "reports/final.md",
                content: "# Final\nDONE\n",
                create_dirs: true,
                overwrite: true,
              },
            },
          ],
        },
        stopReason: "tool_use",
      },
      {
        message: {
          role: "assistant",
          content: "Finished.",
        },
        stopReason: "end_turn",
      },
    ]);

    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: model,
    });

    const result = await agent.run("Update the project status and create a final report.");

    expect(result.finalMessage.content).toBe("Finished.");
    expect(await readFile(path.join(workspaceRoot, "README.md"), "utf8")).toBe("DONE\n");
    expect(await readFile(path.join(workspaceRoot, "reports", "final.md"), "utf8")).toBe("# Final\nDONE\n");

    const loadedSession = await agent.sessionStore.loadSession(result.sessionId);
    expect(loadedSession.corrupted).toBe(false);
    expect(loadedSession.entries.some((entry) => entry.type === "tool_call" && entry.toolName === "read")).toBe(true);
    expect(loadedSession.entries.some((entry) => entry.type === "tool_result" && entry.toolCallId === "call_write")).toBe(true);
  });

  test("activates a workspace skill, exposes its content to later model calls, and runs its script via bash", async () => {
    const workspaceRoot = await createWorkspace();
    await createIntelBulletinSkill(workspaceRoot);
    await writeFile(path.join(workspaceRoot, "source.txt"), "briefing notes\n", "utf8");

    const model = new ScriptedModelAdapter([
      {
        message: {
          role: "assistant",
          content: "I need the bulletin skill.",
          toolCalls: [
            {
              id: "call_activate",
              name: "activate_skill",
              arguments: { name: "intel-bulletin" },
            },
          ],
        },
        stopReason: "tool_use",
      },
      {
        message: {
          role: "assistant",
          content: "I will render the report.",
          toolCalls: [
            {
              id: "call_bash",
              name: "bash",
              arguments: {
                command:
                  "python3 .agents/skills/intel-bulletin/scripts/render_report.py source.txt report.txt",
              },
            },
          ],
        },
        stopReason: "tool_use",
      },
      {
        message: {
          role: "assistant",
          content: "Report rendered.",
        },
        stopReason: "end_turn",
      },
    ]);

    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: model,
    });

    const result = await agent.run("Generate an intel bulletin report.");

    expect(result.finalMessage.content).toBe("Report rendered.");
    expect(await readFile(path.join(workspaceRoot, "report.txt"), "utf8")).toContain("REPORT");
    expect(model.inputs[1]?.systemPrompt).toContain("# Intel Bulletin");

    const loadedSession = await agent.sessionStore.loadSession(result.sessionId);
    expect(loadedSession.entries.some((entry) => entry.type === "skill_activation" && entry.skill === "intel-bulletin")).toBe(true);
  });

  test("returns bash timeout errors to the model as structured tool results", async () => {
    const workspaceRoot = await createWorkspace();
    const model = new ScriptedModelAdapter([
      {
        message: {
          role: "assistant",
          content: "Running a command.",
          toolCalls: [
            {
              id: "call_bash_timeout",
              name: "bash",
              arguments: {
                command: "node -e \"setTimeout(() => console.log('late'), 250)\"",
                timeout_ms: 50,
              },
            },
          ],
        },
        stopReason: "tool_use",
      },
      {
        message: {
          role: "assistant",
          content: "Handled the timeout.",
        },
        stopReason: "end_turn",
      },
    ]);

    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: model,
    });

    const result = await agent.run("Run the slow command.");

    expect(result.finalMessage.content).toBe("Handled the timeout.");
    const session = await agent.sessionStore.loadSession(result.sessionId);
    const timeoutResult = session.entries.find(
      (entry) => entry.type === "tool_result" && entry.toolCallId === "call_bash_timeout",
    );
    expect(timeoutResult).toMatchObject({
      type: "tool_result",
      ok: false,
      error: { code: "TOOL_TIMEOUT" },
    });
  });

  test("persists model errors into the session before surfacing them", async () => {
    const workspaceRoot = await createWorkspace();
    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: {
        name: "mock",
        async generate() {
          throw new Error("model exploded");
        },
      },
    });

    const conversation = await agent.createConversation();

    await expect(conversation.send("Trigger a model failure.")).rejects.toThrow("model exploded");

    const session = await agent.sessionStore.loadSession(conversation.sessionId);
    expect(session.entries.find((entry) => entry.type === "error")).toMatchObject({
      type: "error",
      error: {
        code: "MODEL_ERROR",
        message: "model exploded",
      },
    });
  });

  test("returns EDIT_NO_MATCH when a requested edit target does not exist", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, "notes.md"), "hello world\n", "utf8");

    const model = new ScriptedModelAdapter([
      {
        message: {
          role: "assistant",
          content: "Trying an edit.",
          toolCalls: [
            {
              id: "call_edit_missing",
              name: "edit",
              arguments: {
                path: "notes.md",
                old_text: "missing",
                new_text: "replacement",
              },
            },
          ],
        },
        stopReason: "tool_use",
      },
      {
        message: {
          role: "assistant",
          content: "Edit failed as expected.",
        },
        stopReason: "end_turn",
      },
    ]);

    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: model,
    });

    const result = await agent.run("Try the edit.");

    expect(result.finalMessage.content).toBe("Edit failed as expected.");
    const session = await agent.sessionStore.loadSession(result.sessionId);
    const editResult = session.entries.find(
      (entry) => entry.type === "tool_result" && entry.toolCallId === "call_edit_missing",
    );
    expect(editResult).toMatchObject({
      type: "tool_result",
      ok: false,
      error: { code: "EDIT_NO_MATCH" },
    });
  });

  test("replays tool results back into the model context when resuming a session", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, "README.md"), "resume me\n", "utf8");

    const firstModel = new ScriptedModelAdapter([
      {
        message: {
          role: "assistant",
          content: "Reading before resume.",
          toolCalls: [{ id: "call_read_resume", name: "read", arguments: { path: "README.md" } }],
        },
        stopReason: "tool_use",
      },
      {
        message: {
          role: "assistant",
          content: "First turn complete.",
        },
        stopReason: "end_turn",
      },
    ]);

    const firstAgent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: firstModel,
    });

    const firstResult = await firstAgent.run("Read the file, then stop.");

    const resumedModel = new ScriptedModelAdapter([
      {
        message: {
          role: "assistant",
          content: "Resumed turn complete.",
        },
        stopReason: "end_turn",
      },
    ]);

    const resumedAgent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: resumedModel,
    });

    const resumedConversation = await resumedAgent.createConversation(firstResult.sessionId);
    await resumedConversation.send("Continue from the previous turn.");

    const resumedMessages = resumedModel.inputs[0]?.messages ?? [];
    expect(
      resumedMessages.some(
        (message) => message.role === "tool" && message.toolCallId === "call_read_resume" && message.content.includes("resume me"),
      ),
    ).toBe(true);
  });

  test("restores activated skills into the system prompt when resuming a session", async () => {
    const workspaceRoot = await createWorkspace();
    await createIntelBulletinSkill(workspaceRoot);

    const firstModel = new ScriptedModelAdapter([
      {
        message: {
          role: "assistant",
          content: "Activating the skill.",
          toolCalls: [{ id: "call_activate_resume", name: "activate_skill", arguments: { name: "intel-bulletin" } }],
        },
        stopReason: "tool_use",
      },
      {
        message: {
          role: "assistant",
          content: "Skill activated.",
        },
        stopReason: "end_turn",
      },
    ]);

    const firstAgent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: firstModel,
    });

    const firstResult = await firstAgent.run("Activate the skill.");

    const resumedModel = new ScriptedModelAdapter([
      {
        message: {
          role: "assistant",
          content: "Resumed with the skill.",
        },
        stopReason: "end_turn",
      },
    ]);

    const resumedAgent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: resumedModel,
    });

    const resumedConversation = await resumedAgent.createConversation(firstResult.sessionId);
    await resumedConversation.send("Continue with the activated skill.");

    expect(resumedModel.inputs[0]?.systemPrompt).toContain("# Intel Bulletin");
  });

  test("forwards the run abort signal into model generation", async () => {
    const workspaceRoot = await createWorkspace();
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: {
        name: "mock",
        async generate(input) {
          receivedSignal = input.signal;
          return {
            message: {
              role: "assistant",
              content: "Done.",
            },
            stopReason: "end_turn",
          };
        },
      },
    });

    await agent.run("Test signal forwarding.", controller.signal);

    expect(receivedSignal).toBe(controller.signal);
  });

  test("propagates resume failures for existing sessions instead of creating a replacement session", async () => {
    const workspaceRoot = await createWorkspace();
    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: new ScriptedModelAdapter([
        {
          message: {
            role: "assistant",
            content: "Done.",
          },
          stopReason: "end_turn",
        },
      ]),
    });

    await agent.sessionStore.createSession("sess_existing");
    vi.spyOn(agent.sessionStore, "loadSession").mockRejectedValue(new Error("load failed"));

    await expect(agent.createConversation("sess_existing")).rejects.toThrow("load failed");
  });

  test("refuses to resume corrupted sessions in strict mode", async () => {
    const workspaceRoot = await createWorkspace();
    const store = new SessionStore({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      model: "mock",
    });
    const session = await store.createSession("sess_corrupted_resume");
    const { appendFile } = await import("node:fs/promises");

    await appendFile(
      session.path,
      `${JSON.stringify({
        type: "tool_result",
        toolCallId: "missing",
        ok: true,
        content: "oops",
        timestamp: "2026-04-13T00:00:01.000Z",
      })}\n`,
    );

    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: new ScriptedModelAdapter([
        {
          message: {
            role: "assistant",
            content: "Done.",
          },
          stopReason: "end_turn",
        },
      ]),
    });

    await expect(agent.createConversation(session.sessionId)).rejects.toThrow(/corrupted/i);
  });

  test("caches the base system prompt across two sends in the same conversation", async () => {
    const workspaceRoot = await createWorkspace();
    // The unique marker proves the AGENTS.md content was captured once and
    // reused: if the loop re-read AGENTS.md per send the second system prompt
    // would observe the post-mutation marker. ESM modules block direct
    // `vi.spyOn` on `node:fs/promises.readFile`, so we observe the caching
    // through its externally-visible effect on systemPrompt content instead.
    const agentsPath = path.join(workspaceRoot, "AGENTS.md");
    await writeFile(agentsPath, "MARKER_FIRST\n", "utf8");

    const model = new ScriptedModelAdapter([
      {
        message: { role: "assistant", content: "first reply" },
        stopReason: "end_turn",
      },
      {
        message: { role: "assistant", content: "second reply" },
        stopReason: "end_turn",
      },
    ]);

    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: model,
    });

    const conversation = await agent.createConversation();
    await conversation.send("first prompt");

    // Replace AGENTS.md between sends with a different marker. If the base
    // prompt is cached, the second send still observes MARKER_FIRST.
    await writeFile(agentsPath, "MARKER_SECOND\n", "utf8");

    await conversation.send("second prompt");

    const firstSystem = model.inputs[0]?.systemPrompt ?? "";
    const secondSystem = model.inputs[1]?.systemPrompt ?? "";
    expect(firstSystem).toContain("MARKER_FIRST");
    expect(secondSystem).toContain("MARKER_FIRST");
    expect(secondSystem).not.toContain("MARKER_SECOND");

    await rm(agentsPath);
  });

  test("rescues tool arguments with trailing junk end-to-end and executes the tool normally", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, "README.md"), "RESCUE_OK\n", "utf8");

    // 走真实适配器（注入假 client），验证救援后的 tool call 与干净参数一样正常执行。
    const adapter = new OpenAICompatibleModelAdapter({ model: "any-model", apiKey: "test-key" });
    const responses = [
      {
        id: "chatcmpl_1",
        object: "chat.completion",
        choices: [
          {
            message: {
              content: "Reading the file.",
              tool_calls: [
                {
                  id: "call_dirty_read",
                  type: "function",
                  function: {
                    name: "read",
                    // 平衡对象之后夹带解释性尾巴——应被救援为 {"path":"README.md"}
                    arguments: '{"path":"README.md"} Sorry, here is some extra text.',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      {
        id: "chatcmpl_2",
        object: "chat.completion",
        choices: [{ message: { content: "Done after rescue." }, finish_reason: "stop" }],
      },
    ];
    let callIndex = 0;
    (adapter as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          async create() {
            return responses[callIndex++];
          },
        },
      },
    };

    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: adapter,
    });

    const result = await agent.run("Read the file.");

    expect(result.finalMessage.content).toBe("Done after rescue.");
    const session = await agent.sessionStore.loadSession(result.sessionId);
    const readResult = session.entries.find(
      (entry) => entry.type === "tool_result" && entry.toolCallId === "call_dirty_read",
    );
    expect(readResult).toMatchObject({ type: "tool_result", ok: true });
    expect((readResult as { content: string }).content).toContain("RESCUE_OK");
  });

  test("feeds unparseable tool arguments back to the model and completes when it retries", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, "README.md"), "RETRY_OK\n", "utf8");

    const model = new ScriptedModelAdapter([
      {
        message: {
          role: "assistant",
          content: "Calling read with broken arguments.",
          toolCalls: [
            {
              id: "call_bad_args",
              name: "read",
              arguments: {},
              argumentsParseError: {
                message: "Unexpected end of JSON input",
                rawArguments: '{"path":"README',
                truncated: true,
              },
            },
          ],
        },
        stopReason: "max_tokens",
      },
      {
        message: {
          role: "assistant",
          content: "Retrying with valid arguments.",
          toolCalls: [{ id: "call_retry", name: "read", arguments: { path: "README.md" } }],
        },
        stopReason: "tool_use",
      },
      {
        message: { role: "assistant", content: "Recovered." },
        stopReason: "end_turn",
      },
    ]);

    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: model,
    });

    const result = await agent.run("Read the file.");

    expect(result.finalMessage.content).toBe("Recovered.");

    // 解析失败的调用不真实执行，合成失败结果并写入会话。
    const session = await agent.sessionStore.loadSession(result.sessionId);
    const failedResult = session.entries.find(
      (entry) => entry.type === "tool_result" && entry.toolCallId === "call_bad_args",
    );
    expect(failedResult).toMatchObject({
      type: "tool_result",
      ok: false,
      error: { code: "INVALID_ARGS" },
    });

    // 反馈内容进入下一轮模型上下文：说明不是合法 JSON、带原始参数预览与截断提示。
    const feedback = model.inputs[1]?.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "call_bad_args",
    );
    expect(feedback?.content).toContain("not valid JSON");
    // tool 消息内容是 JSON 序列化后的结果，原始参数预览以转义形式出现。
    expect(feedback?.content).toContain('{\\"path\\":\\"README');
    expect(feedback?.content).toContain("truncated by the max output token limit");

    // 重试的调用真实执行成功。
    const retryResult = session.entries.find(
      (entry) => entry.type === "tool_result" && entry.toolCallId === "call_retry",
    );
    expect(retryResult).toMatchObject({ type: "tool_result", ok: true });
  });

  test("feeds unparseable tool arguments back on the streaming path as well", async () => {
    const workspaceRoot = await createWorkspace();

    const model = new ScriptedModelAdapter([
      {
        message: {
          role: "assistant",
          content: "Calling read with broken arguments.",
          toolCalls: [
            {
              id: "call_bad_stream",
              name: "read",
              arguments: {},
              argumentsParseError: {
                message: "Unexpected token n in JSON",
                rawArguments: "{not json",
                truncated: false,
              },
            },
          ],
        },
        stopReason: "tool_use",
      },
      {
        message: { role: "assistant", content: "Recovered from stream." },
        stopReason: "end_turn",
      },
    ]);

    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: model,
    });

    const conversation = await agent.createConversation();
    // 传入 onModelStreamEvent 使循环走 stream() 路径。
    const result = await conversation.send("Read the file.", undefined, {
      onModelStreamEvent: () => {},
    });

    expect(result.finalMessage.content).toBe("Recovered from stream.");
    const feedback = model.inputs[1]?.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "call_bad_stream",
    );
    expect(feedback?.content).toContain("not valid JSON");
    expect(feedback?.content).not.toContain("truncated by the max output token limit");
  });
});
