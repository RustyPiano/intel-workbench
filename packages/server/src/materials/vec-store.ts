import { readFile } from "node:fs/promises";

import { writeFileAtomic } from "../util/atomic.js";

/**
 * 稠密向量存储（二期 §5.3）。每素材一个 `index/<mid>.vec`：JSON 头（版本戳）+ 换行 +
 * Float32 小端 blob（count × dim，与 chunks.jsonl 同序）。头部版本戳 {embed_model, dim, count}
 * 供读时校验：换模型/维度变/重切块未重嵌 → 忽略该 .vec 退 BM25（避免维度不匹配抛错/算垃圾）。
 *
 * 缓存非权威：可随时由 chunks + embedding 重建。.vec 重建须与 .chunks.jsonl 同提交。
 */

export interface VecHeader {
  embed_model: string;
  dim: number;
  count: number;
}
export interface VecData extends VecHeader {
  vectors: Float32Array[];
}

const NEWLINE = 0x0a;

export async function writeVec(filePath: string, header: VecHeader, vectors: Float32Array[]): Promise<void> {
  const headerBuf = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
  const floatBuf = Buffer.alloc(vectors.length * header.dim * 4);
  let off = 0;
  for (const v of vectors) {
    for (let i = 0; i < header.dim; i++) {
      floatBuf.writeFloatLE(v[i] ?? 0, off);
      off += 4;
    }
  }
  await writeFileAtomic(filePath, Buffer.concat([headerBuf, floatBuf]));
}

/** 读 .vec；缺失/损坏/截断 → null（调用方退 BM25）。不在此校验版本戳（交调用方按当前配置判）。 */
export async function readVec(filePath: string): Promise<VecData | null> {
  let buf: Buffer;
  try {
    buf = await readFile(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const nl = buf.indexOf(NEWLINE);
  if (nl < 0) return null;
  let header: VecHeader;
  try {
    header = JSON.parse(buf.subarray(0, nl).toString("utf8")) as VecHeader;
  } catch {
    return null;
  }
  if (typeof header.dim !== "number" || typeof header.count !== "number" || header.dim <= 0) return null;
  const floatBytes = buf.subarray(nl + 1);
  if (floatBytes.length !== header.count * header.dim * 4) return null; // 截断/损坏
  const vectors: Float32Array[] = [];
  for (let c = 0; c < header.count; c++) {
    const v = new Float32Array(header.dim);
    for (let i = 0; i < header.dim; i++) v[i] = floatBytes.readFloatLE((c * header.dim + i) * 4);
    vectors.push(v);
  }
  return { embed_model: header.embed_model, dim: header.dim, count: header.count, vectors };
}
