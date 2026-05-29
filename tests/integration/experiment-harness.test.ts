import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("experiment harness", () => {
  test("scores the bundled fixtures and tabulates the method comparison", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-exp-"));
    tempRoots.push(outDir);
    const outPath = path.join(outDir, "report.md");

    await execFileAsync(
      "python3",
      ["experiments/run_experiment.py", "--out", outPath],
      { cwd: process.cwd() },
    );

    const report = await readFile(outPath, "utf8");
    // Omni is strongest, classic-pipeline is degraded with no emotion, all get
    // speaker count right. These lock the metric math + table formatting.
    expect(report).toContain("| qwen-omni | 1.000 | 1.000 |");
    expect(report).toContain("| gemini | 0.750 | 0.667 |");
    expect(report).toContain("| classic-pipeline | 0.222 | 0.000 |");
    expect(report).toContain("| qwen-omni | 1.000 | 4/4/4 |");
  });
});
