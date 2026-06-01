import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

describe("volcengine-media-setup readiness", () => {
  test("skill text points ASR API key setup at the current Doubao speech console", async () => {
    const skill = await readFile(path.join(process.cwd(), ".agents", "skills", "volcengine-media-setup", "SKILL.md"), "utf8");

    expect(skill).toContain("https://console.volcengine.com/speech/new/setting/apikeys?projectName=default");
    expect(skill).toContain("https://www.volcengine.com/docs/6561/1816214?lang=zh");
    expect(skill).not.toContain("console.volcengine.com/audioasr");
  });
});
