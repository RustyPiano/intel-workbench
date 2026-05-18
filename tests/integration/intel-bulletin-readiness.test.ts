import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ScriptedModelAdapter } from "../../src/model/mock.js";
import { RuntimeAgent } from "../../src/runtime/agent.js";

const tempRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-intel-bulletin-"));
  tempRoots.push(root);
  return root;
}

async function installBundledIntelBulletinSkill(workspaceRoot: string) {
  const bundledSkillRoot = path.join(process.cwd(), ".agents", "skills", "intel-bulletin");
  const workspaceSkillRoot = path.join(workspaceRoot, ".agents", "skills", "intel-bulletin");
  await mkdir(path.dirname(workspaceSkillRoot), { recursive: true });
  await cp(bundledSkillRoot, workspaceSkillRoot, { recursive: true });
}

describe("intel-bulletin readiness", () => {
  test("renders the bundled intel-bulletin fixture path into the expected report", async () => {
    const workspaceRoot = await createWorkspace();
    await installBundledIntelBulletinSkill(workspaceRoot);

    const sourceFixture = await readFile(path.join(process.cwd(), "fixtures", "intel-bulletin", "source-note.md"), "utf8");
    const expectedReport = await readFile(path.join(process.cwd(), "fixtures", "intel-bulletin", "expected-report.md"), "utf8");
    const sourcePath = path.join(workspaceRoot, "fixtures", "intel-bulletin", "source-note.md");

    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, sourceFixture, "utf8");

    const model = new ScriptedModelAdapter([
      {
        message: {
          role: "assistant",
          content: "I need the intel-bulletin skill first.",
          toolCalls: [{ id: "call_activate_fixture", name: "activate_skill", arguments: { name: "intel-bulletin" } }],
        },
        stopReason: "tool_use",
      },
      {
        message: {
          role: "assistant",
          content: "I will inspect the source notes.",
          toolCalls: [{ id: "call_read_fixture", name: "read", arguments: { path: "fixtures/intel-bulletin/source-note.md" } }],
        },
        stopReason: "tool_use",
      },
      {
        message: {
          role: "assistant",
          content: "I will draft the bulletin body.",
          toolCalls: [
            {
              id: "call_write_fixture",
              name: "write",
              arguments: {
                path: "fixtures/intel-bulletin/bulletin.md",
                content: [
                  "## Decision",
                  "Team approved the launch plan on April 13, 2026.",
                  "",
                  "## Risk",
                  "Vendor turnaround is still unknown.",
                  "",
                  "## Next Step",
                  "Next checkpoint is April 20, 2026.",
                ].join("\n"),
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
          content: "I will render the final report.",
          toolCalls: [
            {
              id: "call_bash_fixture",
              name: "bash",
              arguments: {
                command:
                  "python3 .agents/skills/intel-bulletin/scripts/render_report.py fixtures/intel-bulletin/bulletin.md fixtures/intel-bulletin/report.md",
              },
            },
          ],
        },
        stopReason: "tool_use",
      },
      {
        message: {
          role: "assistant",
          content: "Intel bulletin ready.",
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

    const result = await agent.run("Build the bundled intel bulletin readiness report.");
    const renderedReport = await readFile(path.join(workspaceRoot, "fixtures", "intel-bulletin", "report.md"), "utf8");
    const loadedSession = await agent.sessionStore.loadSession(result.sessionId);

    expect(result.finalMessage.content).toBe("Intel bulletin ready.");
    expect(renderedReport).toBe(expectedReport);
    expect(loadedSession.entries.some((entry) => entry.type === "skill_activation" && entry.skill === "intel-bulletin")).toBe(true);
    expect(loadedSession.entries.some((entry) => entry.type === "tool_call" && entry.toolName === "read")).toBe(true);
    expect(loadedSession.entries.some((entry) => entry.type === "tool_call" && entry.toolName === "write")).toBe(true);
    expect(loadedSession.entries.some((entry) => entry.type === "tool_call" && entry.toolName === "bash")).toBe(true);
  });
});
