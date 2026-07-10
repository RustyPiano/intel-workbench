import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireDataRootLock } from "../src/data/data-root-lock.js";

describe("数据根独占锁", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-lock-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("二实例并发获锁被拒（错误含占用方 pid），释放后可再获", async () => {
    const lock = await acquireDataRootLock(root);
    await expect(acquireDataRootLock(root)).rejects.toThrow(String(process.pid));

    await lock.release();
    const again = await acquireDataRootLock(root); // 释放后可再获
    await again.release();
  });

  it("死 PID 的陈旧锁被回收后可获锁", async () => {
    // spawnSync 返回时子进程已退出 → 其 pid 已死（测试窗口内不会被复用）。
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
    await writeFile(path.join(root, ".workbench.lock"), `${JSON.stringify({ pid: deadPid, startedAt: "x" })}\n`, "utf8");

    const lock = await acquireDataRootLock(root); // 应回收死锁并成功获取
    const holder = JSON.parse(await readFile(path.join(root, ".workbench.lock"), "utf8")) as { pid: number };
    expect(holder.pid).toBe(process.pid);
    await lock.release();
  });
});
