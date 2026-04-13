import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { RuntimeAgent } from "../../src/runtime/agent.js";
import { SessionStore } from "../../src/runtime/session.js";
import { ScriptedModelAdapter } from "../../src/model/mock.js";

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

    const agent = new RuntimeAgent({
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

    const agent = new RuntimeAgent({
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

    const agent = new RuntimeAgent({
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
    const agent = new RuntimeAgent({
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

    const agent = new RuntimeAgent({
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

    const firstAgent = new RuntimeAgent({
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

    const resumedAgent = new RuntimeAgent({
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

    const firstAgent = new RuntimeAgent({
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

    const resumedAgent = new RuntimeAgent({
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

    const agent = new RuntimeAgent({
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
    const agent = new RuntimeAgent({
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

    const agent = new RuntimeAgent({
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
});
