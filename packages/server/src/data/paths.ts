import path from "node:path";

/**
 * 工作区落盘路径（工程方案 §4.1 / §4.2）。所有可变数据以**文件为权威**：
 * 专题产物在 `cases/<id>/`，全局审计在 `audit/audit.jsonl`，用户配置在
 * `config/users.json`（M5）。一期默认数据根 = 进程工作目录（从仓库根运行
 * `npm run dev:server` 时即仓库根），可用 `WORKBENCH_DATA_DIR` 覆盖。
 */
export interface DataPaths {
  readonly root: string;
  readonly casesDir: string;
  readonly auditFile: string;
  readonly usersFile: string;
  caseDir(id: string): string;
  caseManifest(id: string): string;
  caseAuditLog(id: string): string;
}

export function resolveDataPaths(root: string): DataPaths {
  const casesDir = path.join(root, "cases");
  return {
    root,
    casesDir,
    auditFile: path.join(root, "audit", "audit.jsonl"),
    usersFile: path.join(root, "config", "users.json"),
    caseDir: (id) => path.join(casesDir, id),
    caseManifest: (id) => path.join(casesDir, id, "manifest.json"),
    caseAuditLog: (id) => path.join(casesDir, id, "audit.log"),
  };
}

export function defaultDataDir(): string {
  return process.env.WORKBENCH_DATA_DIR ?? process.cwd();
}
