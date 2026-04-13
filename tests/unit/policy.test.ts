import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createPolicyEngine } from "../../src/runtime/policy.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    tempRoots.splice(0).map(async (root) => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }))),
  );
});

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-policy-"));
  tempRoots.push(root);
  return root;
}

describe("policy engine", () => {
  test("allows reads inside the workspace and registered skill roots", async () => {
    const workspaceRoot = await createWorkspace();
    const skillRoot = path.join(workspaceRoot, ".agents", "skills", "demo");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(path.join(skillRoot, "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n");

    const policy = createPolicyEngine({
      workspaceRoot,
      skillRoots: [skillRoot],
    });

    expect(policy.resolveReadPath("notes/todo.md")).toBe(path.join(workspaceRoot, "notes", "todo.md"));
    expect(policy.resolveReadPath(path.join(skillRoot, "SKILL.md"))).toBe(path.join(skillRoot, "SKILL.md"));
  });

  test("rejects reads outside the workspace by default", async () => {
    const workspaceRoot = await createWorkspace();
    const policy = createPolicyEngine({ workspaceRoot });

    expect(() => policy.resolveReadPath("../outside.txt")).toThrowErrorMatchingInlineSnapshot(
      `[Error: Path is outside the allowed read roots: ../outside.txt]`,
    );
  });

  test("rejects writes outside the workspace even when skill roots are readable", async () => {
    const workspaceRoot = await createWorkspace();
    const outsideSkillRoot = await mkdtemp(path.join(os.tmpdir(), "mini-agent-skill-"));
    tempRoots.push(outsideSkillRoot);

    const policy = createPolicyEngine({
      workspaceRoot,
      skillRoots: [outsideSkillRoot],
    });

    expect(() => policy.resolveWritePath(path.join(outsideSkillRoot, "tamper.md"))).toThrowErrorMatchingInlineSnapshot(
      `[Error: Path is outside the allowed write roots: ${path.join(outsideSkillRoot, "tamper.md")}]`,
    );
  });

  test("pins bash execution to the workspace", async () => {
    const workspaceRoot = await createWorkspace();
    const policy = createPolicyEngine({ workspaceRoot });

    expect(policy.resolveExecCwd("scripts")).toBe(path.join(workspaceRoot, "scripts"));
    expect(() => policy.resolveExecCwd("../..")).toThrowErrorMatchingInlineSnapshot(
      `[Error: Path is outside the allowed exec roots: ../..]`,
    );
  });
});
