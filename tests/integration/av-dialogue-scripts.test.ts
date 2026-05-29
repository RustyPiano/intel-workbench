import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const SCRIPT_DIR = path.join(process.cwd(), ".agents", "skills", "av-dialogue-insight", "scripts");
const FIXTURE_DIR = path.join(process.cwd(), "fixtures", "av-dialogue-insight");

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tmp() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-av-"));
  tempRoots.push(root);
  return root;
}

function py(script: string, args: string[], cwd: string) {
  return execFileAsync("python3", [path.join(SCRIPT_DIR, script), ...args], { cwd });
}

describe("av-dialogue-insight scripts", () => {
  test("render_report.py renders the analysis fixture deterministically", async () => {
    const workspace = await tmp();
    const expected = await readFile(path.join(FIXTURE_DIR, "expected-report.md"), "utf8");

    await py("render_report.py", [path.join(FIXTURE_DIR, "analysis.json"), path.join(workspace, "out")], workspace);
    expect(await readFile(path.join(workspace, "out.md"), "utf8")).toBe(expected);
  });

  test("merge_chunks.py shifts per-chunk timestamps and unifies speakers", async () => {
    const workspace = await tmp();
    const expected = JSON.parse(await readFile(path.join(FIXTURE_DIR, "expected-merged.json"), "utf8"));

    await py(
      "merge_chunks.py",
      [
        path.join(workspace, "merged.json"),
        `0:${path.join(FIXTURE_DIR, "chunk0.json")}`,
        `300:${path.join(FIXTURE_DIR, "chunk1.json")}`,
      ],
      workspace,
    );

    const merged = JSON.parse(await readFile(path.join(workspace, "merged.json"), "utf8"));
    // Chunk1's 00:20 event shifts to 05:20 (300s offset); speakers from both chunks unify.
    expect(merged).toEqual(expected);
    expect(merged.events.map((e: { time: string }) => e.time)).toEqual(["00:10", "05:20"]);
    expect(merged.speakers).toHaveLength(2);
  });

  test("fallback_pipeline.py always emits a degraded analysis without crashing", async () => {
    const workspace = await tmp();
    // No real media / no Whisper+pyannote installed → degraded, but still writes JSON.
    await py("fallback_pipeline.py", ["nonexistent.mp4", path.join(workspace, "fallback.json")], workspace);

    const analysis = JSON.parse(await readFile(path.join(workspace, "fallback.json"), "utf8"));
    expect(analysis.degraded).toBe(true);
    expect(analysis.method).toBe("classic-pipeline");
    expect(typeof analysis.degraded_note).toBe("string");
    expect(analysis.emotion_timeline).toEqual([]);
  });
});
