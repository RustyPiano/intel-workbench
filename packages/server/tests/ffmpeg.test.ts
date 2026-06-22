import { describe, expect, it } from "vitest";

import {
  assertLocalFile,
  buildCropImageArgs,
  buildDetectShotsArgs,
  buildExtractAudioArgs,
  buildExtractFrameArgs,
  buildShotRanges,
  normalizedBboxToPixelCrop,
  parseSceneTimestamps,
} from "../src/materials/ffmpeg.js";
import { processVideo } from "../src/materials/media-pipeline.js";
import { MockAsr, MockOcr, MockVlm } from "../src/model/mock-slots.js";

describe("ffmpeg helpers", () => {
  it("parseSceneTimestamps extracts sorted unique pts_time values", () => {
    const stderr = [
      "[Parsed_showinfo_1 @ 0x123] n:   0 pts:  5200 pts_time:5.200 pos: -1 fmt:yuv420p",
      "[Parsed_showinfo_1 @ 0x123] n:   1 pts: 12800 pts_time:12.800 pos: -1 fmt:yuv420p",
      "[Parsed_showinfo_1 @ 0x123] n:   2 pts: 12800 pts_time:12.800 pos: -1 fmt:yuv420p",
      "[Parsed_showinfo_1 @ 0x123] n:   3 pts:  1000 pts_time:1 pos: -1 fmt:yuv420p",
    ].join("\n");

    expect(parseSceneTimestamps(stderr)).toEqual([1, 5.2, 12.8]);
  });

  it("parseSceneTimestamps returns [] for empty stderr", () => {
    expect(parseSceneTimestamps("")).toEqual([]);
  });

  it("parseSceneTimestamps returns [] for unrelated stderr", () => {
    expect(parseSceneTimestamps("frame=1 fps=0.0 q=-0.0 size=N/A time=00:00:01.00")).toEqual([]);
  });

  it("buildShotRanges assembles contiguous ranges", () => {
    expect(buildShotRanges([5.2, 12.8], 20)).toEqual([
      [0, 5.2],
      [5.2, 12.8],
      [12.8, 20],
    ]);
    expect(buildShotRanges([], 10)).toEqual([[0, 10]]);
  });

  it("assertLocalFile rejects protocol and option-injection inputs", () => {
    expect(() => assertLocalFile("http://x")).toThrow("local file paths");
    expect(() => assertLocalFile("concat:http://x")).toThrow("local file paths");
    expect(() => assertLocalFile("subfile:,start,0,end,1,,:/tmp/a.mp4")).toThrow("local file paths");
    expect(() => assertLocalFile("-injectme")).toThrow("local file paths");
  });

  it("ffmpeg arg builders restrict protocols before input", () => {
    for (const args of [
      buildDetectShotsArgs("/tmp/in.mp4"),
      buildExtractFrameArgs("/tmp/in.mp4", 1.25),
      buildExtractAudioArgs("/tmp/in.mp4"),
      buildCropImageArgs("/tmp/in.png", { x: 6, y: 9, width: 19, height: 19 }),
    ]) {
      const inputIndex = args.indexOf("-i");
      expect(inputIndex).toBeGreaterThan(0);
      expect(args.slice(0, inputIndex)).toEqual(expect.arrayContaining(["-nostdin", "-protocol_whitelist", "file,pipe"]));
      expect(args.indexOf("-nostdin")).toBeLessThan(inputIndex);
      expect(args.indexOf("-protocol_whitelist")).toBeLessThan(inputIndex);
    }
  });

  it("converts normalized bbox to clamped integer pixel crop", () => {
    expect(normalizedBboxToPixelCrop({ width: 64, height: 48 }, [0.25, 0.25, 0.5, 0.5])).toEqual({
      x: 16,
      y: 12,
      width: 32,
      height: 24,
    });
    expect(normalizedBboxToPixelCrop({ width: 64, height: 48 }, [0.999, 0.999, 0.0001, 0.0001])).toEqual({
      x: 63,
      y: 47,
      width: 1,
      height: 1,
    });
  });
});

describe("processVideo ffmpeg fallback", () => {
  it("falls back to mock processing when ffmpeg is unavailable", async () => {
    const oldBin = process.env.MINI_AGENT_FFMPEG_BIN;
    process.env.MINI_AGENT_FFMPEG_BIN = "/nonexistent_binary_xyz";
    try {
      const result = await processVideo("m-video", 1, Buffer.alloc(1024), {
        asr: new MockAsr(),
        vlm: new MockVlm(),
        ocr: new MockOcr(),
      });

      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.notes.some((note) => note.includes("real shot detection unavailable"))).toBe(true);
      expect(result.frames.every((frame) => frame.format === "svg")).toBe(true);
      expect(result.frames.map((frame) => frame.key)).toEqual(["0"]);
    } finally {
      if (oldBin === undefined) delete process.env.MINI_AGENT_FFMPEG_BIN;
      else process.env.MINI_AGENT_FFMPEG_BIN = oldBin;
    }
  });
});
