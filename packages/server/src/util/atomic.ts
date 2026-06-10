import { rename, writeFile } from "node:fs/promises";

/**
 * 原子写盘（二期 §2.4 提交点顺序）：先写同目录临时文件，再 rename 覆盖目标。
 * rename 在同一文件系统内是原子的——崩溃只会留下完整旧文件或完整新文件，
 * 永不出现半截写入（manifest/chunks 损坏）。同目录临时文件保证 rename 不跨设备。
 */
let seq = 0;

export async function writeFileAtomic(filePath: string, data: string | Buffer): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${seq++}`;
  await writeFile(tmp, data);
  await rename(tmp, filePath);
}
