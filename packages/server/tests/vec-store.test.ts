import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readVec, writeVec } from "../src/materials/vec-store.js";

describe("vec-store 稠密向量存储（二期 §5.3）", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "iw-vec-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("写后可读回：版本戳 + 向量同序复原", async () => {
    const f = path.join(dir, "m.vec");
    const vectors = [new Float32Array([1, 0, 0]), new Float32Array([0, 0.5, -0.25])];
    await writeVec(f, { embed_model: "mock-embed", dim: 3, count: 2 }, vectors);
    const got = await readVec(f);
    expect(got).not.toBeNull();
    expect(got).toMatchObject({ embed_model: "mock-embed", dim: 3, count: 2 });
    expect(Array.from(got!.vectors[0])).toEqual([1, 0, 0]);
    expect(Array.from(got!.vectors[1])).toEqual([0, 0.5, -0.25]);
  });

  it("缺失文件 → null", async () => {
    expect(await readVec(path.join(dir, "none.vec"))).toBeNull();
  });

  it("截断/损坏（字节数与 count×dim×4 不符）→ null（不抛）", async () => {
    const f = path.join(dir, "bad.vec");
    await writeVec(f, { embed_model: "mock-embed", dim: 3, count: 2 }, [new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6])]);
    await truncate(f, 20); // 砍掉尾部浮点字节
    expect(await readVec(f)).toBeNull();
  });

  it("无 JSON 头（无换行）→ null", async () => {
    const f = path.join(dir, "nohdr.vec");
    await writeFile(f, Buffer.from([1, 2, 3, 4]));
    expect(await readVec(f)).toBeNull();
  });
});
