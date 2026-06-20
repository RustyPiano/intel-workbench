import { afterEach, describe, expect, it, vi } from "vitest";

import { MockAsr, MockOcr, MockVlm } from "../src/model/mock-slots.js";

describe("processVideo ffmpeg frames", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../src/materials/ffmpeg.js");
  });

  it("uses integer frame keys and png format for real ffmpeg frames", async () => {
    vi.doMock("../src/materials/ffmpeg.js", () => ({
      ffmpegAvailable: async () => true,
      probeDuration: async () => 12.5,
      detectShots: async () => [
        [0, 5.2],
        [5.2, 12.5],
      ],
      extractFrame: async (_file: string, t: number) => Buffer.from(`png-${t}`),
      extractAudioWav: async () => Buffer.from("wav"),
    }));
    const { processVideo } = await import("../src/materials/media-pipeline.js");

    const result = await processVideo("m-video", 1, Buffer.alloc(128), {
      asr: new MockAsr(),
      vlm: new MockVlm(),
      ocr: new MockOcr(),
    });

    expect(result.frames.map((frame) => ({ key: frame.key, format: frame.format }))).toEqual([
      { key: "0", format: "png" },
      { key: "1", format: "png" },
    ]);
    expect(result.media.shots.map((shot) => shot.frameKey)).toEqual(["0", "1"]);
    expect(result.chunks.filter((chunk) => chunk.locator.frame !== undefined).map((chunk) => chunk.locator.frame)).toEqual([0, 0, 1, 1]);
  });
});
