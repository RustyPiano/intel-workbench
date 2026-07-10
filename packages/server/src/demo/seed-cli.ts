import { AuditService } from "../audit/audit-service.js";
import { acquireDataRootLock } from "../data/data-root-lock.js";
import { resolveDataPaths } from "../data/paths.js";
import { demoDataRoot, resetDemoWorkspace, seedDemoWorkspace } from "./seed.js";

/**
 * 演示数据 CLI（只操作固定演示数据根 <仓库根>/.workbench-data/demo）：
 * - `seed`：对空的演示数据根从零播种；非空即失败（提示先 reset）。
 * - `reset`：清空演示数据根后从零重建播种（路径硬校验，绝不接受任意路径）。
 */

const command = process.argv[2];
if (command !== "seed" && command !== "reset") {
  // eslint-disable-next-line no-console
  console.error("用法: tsx src/demo/seed-cli.ts <seed|reset>（对应 pnpm demo:seed / pnpm demo:reset）");
  process.exit(1);
}

const root = demoDataRoot();
// 与 server 共用数据根独占锁：server 在跑时 seed/reset 被拒，避免两进程并发写把审计链写分叉。
const lock = await acquireDataRootLock(root);
try {
  if (command === "reset") {
    const result = await resetDemoWorkspace(root);
    // eslint-disable-next-line no-console
    console.log(`reset 完成并重新播种 ${result.caseId} -> ${root}`);
  } else {
    const paths = resolveDataPaths(root);
    const result = await seedDemoWorkspace(paths, new AuditService(paths));
    // eslint-disable-next-line no-console
    console.log(`seeded ${result.caseId} -> ${root}`);
  }
} finally {
  await lock.release();
}
