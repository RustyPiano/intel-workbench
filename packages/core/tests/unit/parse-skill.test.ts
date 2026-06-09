import { describe, expect, test } from "vitest";

import { parseSkillFile } from "../../src/skills/parse-skill.js";

describe("parseSkillFile", () => {
  test("extracts required metadata and preserves the markdown body", () => {
    const record = parseSkillFile(
      `---
name: intel-bulletin
description: Build a bulletin from source notes.
compatibility: Requires Python 3.11+
allowed-tools: read write edit bash activate_skill
metadata:
  version: "1.0.0"
---

# Intel Bulletin

Use this skill when formal report output is needed.
`,
      "/workspace/.agents/skills/intel-bulletin",
      "/workspace/.agents/skills/intel-bulletin/SKILL.md",
    );

    expect(record.meta.name).toBe("intel-bulletin");
    expect(record.meta.allowedTools).toEqual(["read", "write", "edit", "bash", "activate_skill"]);
    expect(record.body).toContain("# Intel Bulletin");
  });

  test("rejects a skill file without required metadata", () => {
    expect(() =>
      parseSkillFile(
        `---
name: invalid
---

# Missing description
`,
        "/workspace/.agents/skills/invalid",
        "/workspace/.agents/skills/invalid/SKILL.md",
      ),
    ).toThrowErrorMatchingInlineSnapshot(`[Error: Skill metadata is missing required field: description]`);
  });
});
