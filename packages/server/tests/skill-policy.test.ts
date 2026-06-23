import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readSkillPolicy, skillPolicyRevision } from "../src/inquiry/skill-policy.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function createConfigDir(): Promise<string> {
  root = await mkdtemp(path.join(tmpdir(), "iw-skill-policy-"));
  const configDir = path.join(root, "config");
  await mkdir(configDir, { recursive: true });
  return configDir;
}

describe("skill policy helpers", () => {
  it("reads disabled skills and revision atomically from one snapshot", async () => {
    const configDir = await createConfigDir();
    const file = path.join(configDir, "skills.json");

    await writeFile(file, `${JSON.stringify({ a: false, b: true })}\n`, "utf8");
    const first = await readSkillPolicy(configDir);
    expect(first.disabledSkillNames).toEqual(["a"]);
    // 同一快照内 revision 与 disabled 必须互相一致（同一次读取派生）。
    expect(first.revision).toBe(await skillPolicyRevision(configDir));

    await writeFile(file, `${JSON.stringify({ a: true, b: false })}\n`, "utf8");
    const second = await readSkillPolicy(configDir);
    expect(second.disabledSkillNames).toEqual(["b"]);
    expect(second.revision).not.toBe(first.revision);
  });

  it("returns defaults when skills.json is missing", async () => {
    const configDir = await createConfigDir();

    await expect(readSkillPolicy(configDir)).resolves.toEqual({ disabledSkillNames: [], revision: "none" });
    await expect(skillPolicyRevision(configDir)).resolves.toBe("none");
  });
});
