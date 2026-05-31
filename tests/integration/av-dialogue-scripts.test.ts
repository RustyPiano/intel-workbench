import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  test("audio_stats.py summarizes normalized ASR envelopes deterministically", async () => {
    const workspace = await tmp();
    const asr = {
      provider: "doubao",
      resourceId: "volc.seedasr.auc",
      language: "zh",
      text: "大家好。预算要调整。可以。",
      durationMs: 4000,
      utterances: [
        { startMs: 0, endMs: 1000, speaker: "S2", text: "大家好。", emotion: "neutral" },
        { startMs: 1000, endMs: 2500, speaker: "S1", text: "预算要调整。", emotion: "angry" },
        { startMs: 3000, endMs: 4000, speaker: "S1", text: "可以。", emotion: "happy" },
      ],
      raw: {},
    };
    await writeFile(path.join(workspace, "asr.json"), JSON.stringify(asr), "utf8");

    const { stdout } = await py("audio_stats.py", ["asr.json", "--offset-seconds", "30"], workspace);
    expect(JSON.parse(stdout)).toEqual({
      total_speech_seconds: 3.5,
      speakers: [
        { speaker: "S1", talk_seconds: 2.5, talk_ratio: 0.714286 },
        { speaker: "S2", talk_seconds: 1, talk_ratio: 0.285714 },
      ],
      emotion_histogram: { angry: 1, happy: 1, neutral: 1 },
      offset_seconds: 30,
      utterances_abs: [
        {
          speaker: "S2",
          start_seconds: 30,
          end_seconds: 31,
          start_time: "00:30",
          end_time: "00:31",
          text: "大家好。",
          emotion: "neutral",
        },
        {
          speaker: "S1",
          start_seconds: 31,
          end_seconds: 32.5,
          start_time: "00:31",
          end_time: "00:32.500",
          text: "预算要调整。",
          emotion: "angry",
        },
        {
          speaker: "S1",
          start_seconds: 33,
          end_seconds: 34,
          start_time: "00:33",
          end_time: "00:34",
          text: "可以。",
          emotion: "happy",
        },
      ],
    });
  });

  test("validate_analysis.py validates and normalizes analysis JSON", async () => {
    const workspace = await tmp();
    await py("validate_analysis.py", [path.join(FIXTURE_DIR, "analysis.json")], workspace);
    await writeFile(path.join(workspace, "minimal.json"), JSON.stringify({ media: "x.mp4" }), "utf8");

    await py("validate_analysis.py", ["minimal.json", "--normalize", "normalized.json"], workspace);

    const normalized = JSON.parse(await readFile(path.join(workspace, "normalized.json"), "utf8"));
    expect(normalized.events).toEqual([]);
    expect(normalized.speakers).toEqual([]);
    expect(normalized.emotion_timeline).toEqual([]);
    expect(normalized.key_triggers).toEqual([]);
  });

  test.each([
    ["non-object JSON", "[]", "analysis must be a JSON object"],
    ["bad duration", JSON.stringify({ duration_seconds: -1 }), "duration_seconds must be numeric and non-negative"],
    ["bad list", JSON.stringify({ events: "nope" }), "events must be a list"],
    ["bad item", JSON.stringify({ events: ["nope"] }), "events[0] must be an object"],
    ["bad event time", JSON.stringify({ events: [{ time: "later" }] }), "events[0].time must be parseable"],
    ["bad talk ratio", JSON.stringify({ speakers: [{ talk_ratio: 2 }] }), "speakers[0].talk_ratio must be numeric"],
    ["bad valence", JSON.stringify({ emotion_timeline: [{ valence: -2 }] }), "emotion_timeline[0].valence must be numeric"],
  ])("validate_analysis.py rejects %s", async (_name, content, message) => {
    const workspace = await tmp();
    await writeFile(path.join(workspace, "bad.json"), content, "utf8");

    await expect(py("validate_analysis.py", ["bad.json"], workspace)).rejects.toMatchObject({
      stderr: expect.stringContaining(message),
    });
  });
});
