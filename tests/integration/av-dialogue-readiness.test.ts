import { cp, mkdtemp, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ScriptedModelAdapter } from "../../src/model/mock.js";
import { RuntimeAgent } from "../../src/runtime/agent.js";

const tempRoots: string[] = [];
const SCRIPTS = ".agents/skills/av-dialogue-insight/scripts";

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-av-readiness-"));
  tempRoots.push(root);
  return root;
}

async function installSkill(workspaceRoot: string) {
  const bundled = path.join(process.cwd(), ".agents", "skills", "av-dialogue-insight");
  const target = path.join(workspaceRoot, ".agents", "skills", "av-dialogue-insight");
  await mkdir(path.dirname(target), { recursive: true });
  await cp(bundled, target, { recursive: true });
}

describe("av-dialogue-insight readiness", () => {
  test("skill text describes the supported deterministic media workflow", async () => {
    const skill = await readFile(path.join(process.cwd(), ".agents", "skills", "av-dialogue-insight", "SKILL.md"), "utf8");

    expect(skill).toContain("analyze_audio");
    expect(skill).toMatch(/Public audio URL:[\s\S]*analyze_audio/u);
    expect(skill).toMatch(/Video or image:[\s\S]*probe_media[\s\S]*analyze_media/u);
    expect(skill).toMatch(/inline by default/u);
    expect(skill).toMatch(/out_path[\s\S]*read that file/u);
    expect(skill).toContain("audio_stats.py");
    expect(skill).toMatch(/talk ratio|emotion counts/u);
    expect(skill).toMatch(/Transcript errors are expected|correct likely transcript recognition errors/u);
    expect(skill).toMatch(/Local audio[\s\S]*TODO|TODO[\s\S]*local audio/u);
    expect(skill).toMatch(/URL-only/u);
    expect(skill).toContain("split_media.py");
    expect(skill).toContain("validate_analysis.py");
    expect(skill).toContain("MINI_AGENT_ASR_*");
    expect(skill).not.toMatch(/≤\s*~?360s|360s/u);
    expect(skill).not.toMatch(/URL\/OSS|OSS upload/u);
    expect(skill).toMatch(/kind/u);
    expect(skill).toMatch(/format/u);
  });

  test("activates the skill and renders a consolidated analysis into the expected report", async () => {
    const workspaceRoot = await createWorkspace();
    await installSkill(workspaceRoot);

    const fixtureRoot = path.join(process.cwd(), "fixtures", "av-dialogue-insight");
    const analysisJson = await readFile(path.join(fixtureRoot, "analysis.json"), "utf8");
    const expectedReport = await readFile(path.join(fixtureRoot, "expected-report.md"), "utf8");

    const model = new ScriptedModelAdapter([
      {
        message: {
          role: "assistant",
          content: "Activate the analysis skill.",
          toolCalls: [{ id: "call_activate", name: "activate_skill", arguments: { name: "av-dialogue-insight" } }],
        },
        stopReason: "tool_use",
      },
      {
        message: {
          role: "assistant",
          content: "Persist the consolidated multimodal analysis.",
          toolCalls: [
            {
              id: "call_write_analysis",
              name: "write",
              arguments: {
                path: "av-tasks/demo/analysis/merged.json",
                content: analysisJson,
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
                command: `python3 ${SCRIPTS}/render_report.py av-tasks/demo/analysis/merged.json av-tasks/demo/report/report`,
              },
            },
          ],
        },
        stopReason: "tool_use",
      },
      {
        message: { role: "assistant", content: "Analysis report ready." },
        stopReason: "end_turn",
      },
    ]);

    const agent = await RuntimeAgent.create({
      workspaceRoot,
      runtimeVersion: "1.0.0",
      modelName: "mock",
      modelAdapter: model,
    });

    const result = await agent.run("Analyze the demo recording and produce a report.");

    const rendered = await readFile(path.join(workspaceRoot, "av-tasks", "demo", "report", "report.md"), "utf8");
    expect(rendered).toBe(expectedReport);

    const loadedSession = await agent.sessionStore.loadSession(result.sessionId);
    expect(result.finalMessage.content).toBe("Analysis report ready.");
    expect(loadedSession.entries.some((e) => e.type === "skill_activation" && e.skill === "av-dialogue-insight")).toBe(true);
    expect(loadedSession.entries.some((e) => e.type === "tool_call" && e.toolName === "write")).toBe(true);
    expect(loadedSession.entries.some((e) => e.type === "tool_call" && e.toolName === "bash")).toBe(true);
  });
});
