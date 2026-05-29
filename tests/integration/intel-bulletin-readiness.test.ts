import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ScriptedModelAdapter } from "../../src/model/mock.js";
import { RuntimeAgent } from "../../src/runtime/agent.js";

const tempRoots: string[] = [];
const SCRIPTS = ".agents/skills/intel-bulletin/scripts";

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
  test("compiles a multi-source task into the expected 公文 report end-to-end", async () => {
    const workspaceRoot = await createWorkspace();
    await installBundledIntelBulletinSkill(workspaceRoot);

    const fixtureRoot = path.join(process.cwd(), "fixtures", "intel-bulletin");
    const brief = await readFile(path.join(fixtureRoot, "sources", "brief.md"), "utf8");
    const memo = await readFile(path.join(fixtureRoot, "sources", "memo.txt"), "utf8");
    const specJson = await readFile(path.join(fixtureRoot, "bulletin.spec.json"), "utf8");
    const expectedReport = await readFile(path.join(fixtureRoot, "expected-report.md"), "utf8");

    // Stage the raw source files in the workspace; the agent copies them into
    // the task via manage_task add-source.
    await mkdir(path.join(workspaceRoot, "staging"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "staging", "brief.md"), brief, "utf8");
    await writeFile(path.join(workspaceRoot, "staging", "memo.txt"), memo, "utf8");

    const model = new ScriptedModelAdapter([
      {
        message: {
          role: "assistant",
          content: "I need the intel-bulletin skill first.",
          toolCalls: [{ id: "call_activate", name: "activate_skill", arguments: { name: "intel-bulletin" } }],
        },
        stopReason: "tool_use",
      },
      {
        message: {
          role: "assistant",
          content: "Create the task and add both sources.",
          toolCalls: [
            {
              id: "call_create",
              name: "bash",
              arguments: {
                command: [
                  `python3 ${SCRIPTS}/manage_task.py create demo --title "发射计划进展"`,
                  `python3 ${SCRIPTS}/manage_task.py add-source demo staging/brief.md`,
                  `python3 ${SCRIPTS}/manage_task.py add-source demo staging/memo.txt`,
                ].join(" && "),
              },
            },
          ],
        },
        stopReason: "tool_use",
      },
      {
        message: {
          role: "assistant",
          content: "Ingest the sources.",
          toolCalls: [
            { id: "call_ingest", name: "bash", arguments: { command: `python3 ${SCRIPTS}/ingest.py tasks/demo/sources` } },
          ],
        },
        stopReason: "tool_use",
      },
      {
        message: {
          role: "assistant",
          content: "Draft the bulletin spec.",
          toolCalls: [
            {
              id: "call_write_spec",
              name: "write",
              arguments: {
                path: "tasks/demo/report/bulletin.spec.json",
                content: specJson,
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
          content: "Render the report.",
          toolCalls: [
            {
              id: "call_render",
              name: "bash",
              arguments: {
                command: `python3 ${SCRIPTS}/render_report.py tasks/demo/report/bulletin.spec.json tasks/demo/report/bulletin`,
              },
            },
          ],
        },
        stopReason: "tool_use",
      },
      {
        message: {
          role: "assistant",
          content: "Register the produced report.",
          toolCalls: [
            {
              id: "call_set_report",
              name: "bash",
              arguments: { command: `python3 ${SCRIPTS}/manage_task.py set-report demo report/bulletin.md` },
            },
          ],
        },
        stopReason: "tool_use",
      },
      {
        message: { role: "assistant", content: "Intel bulletin ready." },
        stopReason: "end_turn",
      },
    ]);

    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: model,
    });

    const result = await agent.run("Compile the demo launch task into an intelligence bulletin.");

    const renderedReport = await readFile(path.join(workspaceRoot, "tasks", "demo", "report", "bulletin.md"), "utf8");
    expect(renderedReport).toBe(expectedReport);

    const manifest = JSON.parse(
      await readFile(path.join(workspaceRoot, "tasks", "demo", "manifest.json"), "utf8"),
    ) as { status: string; sources: unknown[]; report: string };
    expect(manifest.status).toBe("rendered");
    expect(manifest.sources).toHaveLength(2);
    expect(manifest.report).toBe("report/bulletin.md");

    const loadedSession = await agent.sessionStore.loadSession(result.sessionId);
    expect(result.finalMessage.content).toBe("Intel bulletin ready.");
    expect(loadedSession.entries.some((e) => e.type === "skill_activation" && e.skill === "intel-bulletin")).toBe(true);
    expect(loadedSession.entries.some((e) => e.type === "tool_call" && e.toolName === "write")).toBe(true);
    expect(loadedSession.entries.some((e) => e.type === "tool_call" && e.toolName === "bash")).toBe(true);
  });
});
