import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { discoverSkills } from "../../src/skills/discover.js";

const tempRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function writeSkill(root: string, name: string, description: string) {
  const skillRoot = path.join(root, name);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    path.join(skillRoot, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---

# ${name}
`,
  );
}

describe("discoverSkills", () => {
  test("prefers later explicit skill dirs over earlier ones on name conflict", async () => {
    const workspaceRoot = await createTempDir("mini-agent-workspace-");
    const explicitA = await createTempDir("mini-agent-skills-a-");
    const explicitB = await createTempDir("mini-agent-skills-b-");

    await writeSkill(explicitA, "shared-skill", "from first dir");
    await writeSkill(explicitB, "shared-skill", "from second dir");

    const result = await discoverSkills({
      workspaceRoot,
      explicitSkillDirs: [explicitA, explicitB],
      globalSkillDirs: [],
    });

    expect(result.catalog).toHaveLength(1);
    expect(result.catalog[0]?.description).toBe("from second dir");
    expect(result.warnings).toContain(`Skill conflict for shared-skill: ${path.join(explicitB, "shared-skill")}`);
  });

  test("prefers workspace skills over global skills", async () => {
    const workspaceRoot = await createTempDir("mini-agent-workspace-");
    const workspaceSkillsRoot = path.join(workspaceRoot, ".agents", "skills");
    const globalRoot = await createTempDir("mini-agent-global-skills-");

    await writeSkill(globalRoot, "workspace-first", "from global");
    await writeSkill(workspaceSkillsRoot, "workspace-first", "from workspace");

    const result = await discoverSkills({
      workspaceRoot,
      explicitSkillDirs: [],
      globalSkillDirs: [globalRoot],
    });

    expect(result.catalog[0]?.description).toBe("from workspace");
  });
});
