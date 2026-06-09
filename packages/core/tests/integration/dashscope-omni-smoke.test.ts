import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { callOmni } from "../../src/model/multimodal.js";
import type { MultimodalToolConfig } from "../../src/tools/types.js";

const shouldRun =
  process.env.RUN_DASHSCOPE_OMNI_SMOKE === "1" &&
  Boolean(process.env.DASHSCOPE_API_KEY || process.env.MINI_AGENT_MM_API_KEY);
const smokeDescribe = shouldRun ? describe : describe.skip;
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function config(): MultimodalToolConfig {
  return {
    provider: "openai-compatible",
    model: process.env.MINI_AGENT_MM_MODEL ?? "qwen3.5-omni-plus",
    baseURL: process.env.MINI_AGENT_MM_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: process.env.MINI_AGENT_MM_API_KEY ?? process.env.DASHSCOPE_API_KEY,
  };
}

function wavTone(): Buffer {
  const sampleRate = 16_000;
  const durationSeconds = 1;
  const samples = sampleRate * durationSeconds;
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 12_000);
    buffer.writeInt16LE(value, 44 + index * 2);
  }
  return buffer;
}

smokeDescribe("DashScope Qwen-Omni smoke", () => {
  test(
    "handles a local audio file",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-dashscope-smoke-"));
      tempRoots.push(root);
      const audioPath = path.join(root, "tone.wav");
      await writeFile(audioPath, wavTone());

      const result = await callOmni({
        config: config(),
        source: { type: "file", path: audioPath },
        instruction: "Describe this audio in one short sentence.",
      });

      expect(result.text.trim().length).toBeGreaterThan(0);
    },
    120_000,
  );

  test(
    "handles a provider-doc public image URL",
    async () => {
      const result = await callOmni({
        config: config(),
        source: {
          type: "url",
          kind: "image",
          url: "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241022/emyrja/dog_and_girl.jpeg",
        },
        instruction: "What scene is depicted in the image? Answer briefly.",
      });

      expect(result.text.trim().length).toBeGreaterThan(0);
    },
    120_000,
  );
});
