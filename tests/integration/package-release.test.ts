import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

interface PackedFile {
  path: string;
}

interface PackDryRun {
  files: PackedFile[];
}

describe("npm package release contents", () => {
  test(
    "publishes only runtime assets and excludes local workspace state",
    async () => {
      const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
        cwd: process.cwd(),
        maxBuffer: 10 * 1024 * 1024,
      });
      const [pack] = JSON.parse(stdout) as PackDryRun[];
      const paths = pack.files.map((file) => file.path).sort();

      expect(paths).toContain("README.md");
      expect(paths).toContain("package.json");
      expect(paths).toContain("dist/src/cli/bin.js");
      expect(paths).toContain(".agents/skills/intel-bulletin/SKILL.md");

      for (const forbiddenPrefix of [".mini-agent/", ".claude/", "src/", "tests/", "dist/tests/", "fixtures/"]) {
        expect(paths.filter((entry) => entry.startsWith(forbiddenPrefix))).toEqual([]);
      }
    },
    30_000,
  );
});
