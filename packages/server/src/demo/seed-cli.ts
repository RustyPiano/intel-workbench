import { AuditService } from "../audit/audit-service.js";
import { acquireDataRootLock } from "../data/data-root-lock.js";
import { defaultDataDir, resolveDataPaths } from "../data/paths.js";
import { seedDemoWorkspace } from "./seed.js";

const paths = resolveDataPaths(defaultDataDir());
// 与 server 共用数据根独占锁：server 在跑时 seed 被拒，避免两进程并发写把审计链写分叉。
const lock = await acquireDataRootLock(paths.root);
try {
  const audit = new AuditService(paths);
  const result = await seedDemoWorkspace(paths, audit);
  // eslint-disable-next-line no-console
  console.log(`${result.seeded ? "seeded" : "exists"} ${result.caseId} in ${paths.root}`);
} finally {
  await lock.release();
}
