import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const SCRIPT_DIR = path.join(process.cwd(), ".agents", "skills", "av-dialogue-insight", "scripts");
const FIXTURE_DIR = path.join(process.cwd(), "fixtures", "av-dialogue-insight");
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const hasFfprobe = spawnSync("ffprobe", ["-version"]).status === 0;

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

  test("merge_chunks.py reads offsets from a split manifest", async () => {
    const workspace = await tmp();
    await mkdir(path.join(workspace, "chunks", "analysis"), { recursive: true });
    await writeFile(
      path.join(workspace, "chunks", "chunks.json"),
      JSON.stringify(
        {
          chunks: [
            { path: "chunk0.mp4", offset_seconds: 0, duration_seconds: 300, size_bytes: 100 },
            { path: "chunk1.mp4", offset_seconds: 300, duration_seconds: 120, size_bytes: 100 },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      path.join(workspace, "chunks", "analysis", "chunk0.json"),
      await readFile(path.join(FIXTURE_DIR, "chunk0.json"), "utf8"),
      "utf8",
    );
    await writeFile(
      path.join(workspace, "chunks", "analysis", "chunk1.json"),
      await readFile(path.join(FIXTURE_DIR, "chunk1.json"), "utf8"),
      "utf8",
    );

    await py(
      "merge_chunks.py",
      ["--manifest", "chunks/chunks.json", "--analysis-dir", "analysis", "manifest-merged.json"],
      workspace,
    );

    const merged = JSON.parse(await readFile(path.join(workspace, "manifest-merged.json"), "utf8"));
    expect(merged.events.map((event: { time: string }) => event.time)).toEqual(["00:10", "05:20"]);
    expect(merged.summary).toContain("Chunk 0 (00:00)");
    expect(merged.summary).toContain("Chunk 1 (05:00)");

    await mkdir(path.join(workspace, "analysis"), { recursive: true });
    await writeFile(
      path.join(workspace, "analysis", "chunk0.json"),
      await readFile(path.join(FIXTURE_DIR, "chunk0.json"), "utf8"),
      "utf8",
    );
    await writeFile(
      path.join(workspace, "analysis", "chunk1.json"),
      await readFile(path.join(FIXTURE_DIR, "chunk1.json"), "utf8"),
      "utf8",
    );
    await py(
      "merge_chunks.py",
      ["--manifest", "chunks/chunks.json", "--analysis-dir", "analysis", "cwd-merged.json"],
      workspace,
    );
    const cwdMerged = JSON.parse(await readFile(path.join(workspace, "cwd-merged.json"), "utf8"));
    expect(cwdMerged.events.map((event: { time: string }) => event.time)).toEqual(["00:10", "05:20"]);
  });

  test("merge_chunks.py deduplicates nearby events and reweights speaker ratios", async () => {
    const workspace = await tmp();
    const first = {
      media: "clip.mp4",
      duration_seconds: 10,
      summary: "first",
      events: [{ time: "10.1", title: "Decision", detail: "short" }],
      speakers: [{ id: "S1", label: "Lead", talk_seconds: 5, profile: "主持。" }],
    };
    const second = {
      media: "clip.mp4",
      duration_seconds: 10,
      summary: "second",
      events: [{ time: "0.9", title: " decision ", detail: "longer duplicate detail" }],
      speakers: [{ id: "S1", label: "Lead", talk_ratio: 0.5, profile: "主持。" }],
    };
    await writeFile(path.join(workspace, "a.json"), JSON.stringify(first), "utf8");
    await writeFile(path.join(workspace, "b.json"), JSON.stringify(second), "utf8");

    await py("merge_chunks.py", ["--dedupe-window-seconds", "2", "merged.json", "0:a.json", "10:b.json"], workspace);

    const merged = JSON.parse(await readFile(path.join(workspace, "merged.json"), "utf8"));
    expect(merged.events).toHaveLength(1);
    expect(merged.events[0].detail).toBe("longer duplicate detail");
    expect(merged.speakers[0].talk_ratio).toBe(0.5);
    expect(merged.speakers[0].talk_seconds).toBe(10);
  });

  test("merge_chunks.py deduplicates events across dedupe bucket boundaries", async () => {
    const workspace = await tmp();
    await writeFile(
      path.join(workspace, "a.json"),
      JSON.stringify({
        media: "clip.mp4",
        duration_seconds: 5,
        events: [{ time: "1.9", title: "Decision", detail: "short" }],
      }),
      "utf8",
    );
    await writeFile(
      path.join(workspace, "b.json"),
      JSON.stringify({
        media: "clip.mp4",
        duration_seconds: 5,
        events: [{ time: "2.1", title: " decision ", detail: "longer duplicate detail" }],
      }),
      "utf8",
    );

    await py("merge_chunks.py", ["--dedupe-window-seconds", "2", "merged.json", "0:a.json", "0:b.json"], workspace);

    const merged = JSON.parse(await readFile(path.join(workspace, "merged.json"), "utf8"));
    expect(merged.events).toHaveLength(1);
    expect(merged.events[0].detail).toBe("longer duplicate detail");
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

  test.skipIf(!(hasFfmpeg && hasFfprobe))("split_media.py writes portable chunks and a manifest", async () => {
    const workspace = await tmp();
    const input = path.join(workspace, "input.mp4");
    await execFileAsync("ffmpeg", [
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=64x64:rate=1:duration=4",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=4",
      "-shortest",
      "-pix_fmt",
      "yuv420p",
      "-y",
      input,
    ]);

    await py("split_media.py", ["input.mp4", "chunks", "--seconds", "2"], workspace);

    const manifest = JSON.parse(await readFile(path.join(workspace, "chunks", "chunks.json"), "utf8"));
    expect(manifest.chunks).toHaveLength(2);
    for (const chunk of manifest.chunks as Array<Record<string, unknown>>) {
      expect(chunk.path).toMatch(/^chunk\d+\.mp4$/u);
      expect(typeof chunk.offset_seconds).toBe("number");
      expect(chunk.duration_seconds).toBe(2);
      expect(typeof chunk.size_bytes).toBe("number");
      expect(path.isAbsolute(String(chunk.path))).toBe(false);
      const probe = await execFileAsync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path.join(workspace, "chunks", String(chunk.path)),
      ]);
      expect(Number(probe.stdout.trim())).toBeGreaterThan(0);
    }
  });

  test.skipIf(!(hasFfmpeg && hasFfprobe))("split_media.py fallback re-encode emits a compatible mp4 chunk", async () => {
    const workspace = await tmp();
    await execFileAsync("ffmpeg", [
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=64x64:rate=1:duration=2",
      "-c:v",
      "libvpx-vp9",
      "-y",
      "input.webm",
    ], { cwd: workspace });

    await py("split_media.py", ["input.webm", "chunks", "--seconds", "2", "--force-reencode"], workspace);

    const manifest = JSON.parse(await readFile(path.join(workspace, "chunks", "chunks.json"), "utf8"));
    expect(manifest.chunks[0].path).toBe("chunk0.mp4");
    const probe = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=format_name,duration",
      "-of",
      "json",
      path.join(workspace, "chunks", "chunk0.mp4"),
    ]);
    const parsed = JSON.parse(probe.stdout);
    expect(parsed.format.format_name).toContain("mp4");
    expect(Number(parsed.format.duration)).toBeGreaterThan(0);
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
