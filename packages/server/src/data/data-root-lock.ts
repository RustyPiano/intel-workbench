import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * 数据根独占锁（§4.1 / §7.2）。同一数据根（`cases/`、`audit/audit.jsonl` 等）
 * 绝不能被两个进程并发写——各自持独立内存 `lastHash`，并发追加会把审计哈希链写分叉。
 *
 * 机制：`<dataRoot>/.workbench.lock`，`open(..., "wx")` 原子创建，内容 `{pid, startedAt}`。
 * 已存在时读锁文件用 `process.kill(pid, 0)` 判存活：死 PID（或锁文件损坏）删锁重试一次；
 * 活 PID 抛清晰错误（含占用方 pid）。优雅关停时 `release()` 删锁；异常崩溃遗留的死锁
 * 由下一次获锁的存活判定回收。
 *
 * ponytail: 单文件全局锁，够本地单机数据根用；若将来要多数据根/网络文件系统再谈升级。
 */

const LOCK_FILE = ".workbench.lock";

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = 无此进程（死）；EPERM 等其它错误说明进程在（无权发信号即为活）。
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export interface DataRootLock {
  /** 删除锁文件释放独占（优雅关停时调用）；重复/竞态删除吞掉。 */
  release(): Promise<void>;
}

/** 获数据根独占锁；已被存活进程占用则抛错。 */
export async function acquireDataRootLock(dataRoot: string): Promise<DataRootLock> {
  const lockPath = path.join(dataRoot, LOCK_FILE);
  await mkdir(dataRoot, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
      await handle.close();
      return { release: () => unlink(lockPath).catch(() => undefined) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    // 锁已存在：查占用方存活。读不出/解析失败视同死锁。
    let holderPid: number | undefined;
    try {
      holderPid = (JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number }).pid;
    } catch {
      holderPid = undefined;
    }
    if (typeof holderPid === "number" && processIsAlive(holderPid)) {
      throw new Error(
        `数据根已被进程 ${holderPid} 占用（${lockPath}）。同一数据根不可并发写入；` +
          `请先停止占用进程，或用 WORKBENCH_DATA_DIR 指向另一数据根。`,
      );
    }
    // 死锁（或损坏锁）：删掉重试一次。
    await unlink(lockPath).catch(() => undefined);
  }

  throw new Error(`无法获取数据根锁（${lockPath}）：反复被占用。`);
}
