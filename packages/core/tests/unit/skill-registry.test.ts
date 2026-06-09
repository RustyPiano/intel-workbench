import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { SkillRegistry } from "../../src/skills/registry.js";

const tempRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-skills-"));
  tempRoots.push(root);
  return root;
}

describe("SkillRegistry", () => {
  test("loads skill body and resource list lazily on activation", async () => {
    const workspaceRoot = await createWorkspace();
    const skillRoot = path.join(workspaceRoot, ".agents", "skills", "demo");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      path.join(skillRoot, "SKILL.md"),
      `---
name: demo
description: demo skill
---

# Initial Body
`,
      "utf8",
    );

    const registry = await SkillRegistry.discover({
      workspaceRoot,
      explicitSkillDirs: [],
      globalSkillDirs: [],
    });

    await mkdir(path.join(skillRoot, "references"), { recursive: true });
    await writeFile(
      path.join(skillRoot, "SKILL.md"),
      `---
name: demo
description: demo skill
---

# Updated Body
`,
      "utf8",
    );
    await writeFile(path.join(skillRoot, "references", "guide.md"), "# guide\n", "utf8");

    const activated = await registry.activate("demo");

    expect(activated.record.body).toContain("# Updated Body");
    expect(activated.record.resources.references).toContain("references/guide.md");
  });
});
