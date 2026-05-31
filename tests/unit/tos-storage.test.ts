import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { publishFileToTos, type TosStorageClient } from "../../src/model/tos-storage.js";
import { RuntimeError } from "../../src/runtime/errors.js";
import type { TosStorageConfig } from "../../src/tools/types.js";

const tempRoots: string[] = [];

const config: TosStorageConfig = {
  accessKeyId: "ak",
  accessKeySecret: "sk",
  bucket: "media-bucket",
  region: "cn-beijing",
  endpoint: "https://tos-cn-beijing.volces.com",
  prefix: "/mini-agent//uploads/",
  signedUrlExpires: 900,
};

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-31T12:00:00.000Z"));
});

async function createFile(name: string, bytes = Buffer.from("media")): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-tos-"));
  tempRoots.push(root);
  const filePath = path.join(root, name);
  await writeFile(filePath, bytes);
  return filePath;
}

function fakeClient(options: { failPut?: Error } = {}): {
  client: TosStorageClient;
  putCalls: Array<Record<string, unknown>>;
  signedUrlCalls: Array<Record<string, unknown>>;
} {
  const putCalls: Array<Record<string, unknown>> = [];
  const signedUrlCalls: Array<Record<string, unknown>> = [];
  const client: TosStorageClient = {
    async putObjectFromFile(input) {
      putCalls.push(input);
      if (options.failPut) {
        throw options.failPut;
      }
    },
    getPreSignedUrl(input) {
      signedUrlCalls.push(input);
      return `https://signed.example/${input.bucket}/${input.key}?expires=${input.expires}`;
    },
  };
  return { client, putCalls, signedUrlCalls };
}

describe("publishFileToTos", () => {
  test("uploads with a normalized key, passes contentType, and returns signed metadata", async () => {
    const filePath = await createFile("clip.mp4", Buffer.from([1, 2, 3, 4, 5]));
    const { client, putCalls, signedUrlCalls } = fakeClient();

    const published = await publishFileToTos({
      config,
      filePath,
      runId: "run-1",
      toolCallId: "tool-2",
      contentType: "video/mp4",
      client,
    });

    const expectedKey = "mini-agent/uploads/run-1/tool-2/1780228800000-clip.mp4";
    expect(putCalls).toEqual([
      {
        bucket: "media-bucket",
        key: expectedKey,
        filePath,
        contentType: "video/mp4",
      },
    ]);
    expect(putCalls[0]).not.toHaveProperty("acl");
    expect(signedUrlCalls).toEqual([
      {
        bucket: "media-bucket",
        key: expectedKey,
        method: "GET",
        expires: 900,
      },
    ]);
    expect(published).toEqual({
      url: `https://signed.example/media-bucket/${expectedKey}?expires=900`,
      bucket: "media-bucket",
      key: expectedKey,
      expiresSeconds: 900,
      sizeBytes: 5,
    });
  });

  test("sanitizes basename slashes and control characters", async () => {
    const filePath = await createFile("bad\\name\u0001.mp3");
    const { client, putCalls } = fakeClient();

    await publishFileToTos({
      config: { ...config, prefix: "///" },
      filePath,
      runId: "run-1",
      toolCallId: "tool-2",
      client,
    });

    expect(putCalls[0]?.key).toBe("run-1/tool-2/1780228800000-bad_name_.mp3");
  });

  test("wraps client failures as TOS model errors", async () => {
    const filePath = await createFile("clip.wav");
    const { client } = fakeClient({ failPut: new Error("upload denied") });

    await expect(
      publishFileToTos({
        config,
        filePath,
        runId: "run-1",
        toolCallId: "tool-2",
        client,
      }),
    ).rejects.toMatchObject({
      name: "RuntimeError",
      code: "MODEL_ERROR",
      message: "Failed to publish media to TOS: upload denied",
      details: { category: "tos", cause: "upload denied" },
    });

    await expect(
      publishFileToTos({
        config,
        filePath,
        runId: "run-1",
        toolCallId: "tool-2",
        client,
      }),
    ).rejects.toBeInstanceOf(RuntimeError);
  });

  test("reports missing local files as invalid arguments before TOS upload", async () => {
    const { client, putCalls, signedUrlCalls } = fakeClient();
    const missingPath = path.join(os.tmpdir(), "mini-agent-missing-media.wav");

    await expect(
      publishFileToTos({
        config,
        filePath: missingPath,
        runId: "run-1",
        toolCallId: "tool-2",
        client,
      }),
    ).rejects.toMatchObject({
      name: "RuntimeError",
      code: "INVALID_ARGS",
      message: expect.stringContaining("Cannot read local media file"),
      details: { category: "file", path: missingPath },
    });
    expect(putCalls).toEqual([]);
    expect(signedUrlCalls).toEqual([]);
  });
});
