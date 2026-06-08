import path from "node:path";

import { AppError } from "../domain/identity.js";

/**
 * 校验来自 URL/外部的标识符（caseId 等）在拼入文件路径前不含路径穿越成分。
 * 红线：所有由 id 派生的落盘路径都必须经此，杜绝 `../`、分隔符、空字节穿越
 * （如 `GET /api/cases/..%2f..%2fsecret`）。
 */
export function assertSafeId(id: string): string {
  if (!id || id === "." || id === ".." || /[/\\\0]/.test(id) || id.includes("..")) {
    throw new AppError(400, "非法标识符");
  }
  return id;
}

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
  readonly configDir: string;
  readonly usersFile: string;
  caseDir(id: string): string;
  caseManifest(id: string): string;
  caseAuditLog(id: string): string;
}

export function resolveDataPaths(root: string): DataPaths {
  const casesDir = path.join(root, "cases");
  const configDir = path.join(root, "config");
  return {
    root,
    casesDir,
    auditFile: path.join(root, "audit", "audit.jsonl"),
    configDir,
    usersFile: path.join(configDir, "users.json"),
    caseDir: (id) => path.join(casesDir, assertSafeId(id)),
    caseManifest: (id) => path.join(casesDir, assertSafeId(id), "manifest.json"),
    caseAuditLog: (id) => path.join(casesDir, assertSafeId(id), "audit.log"),
  };
}

export function defaultDataDir(): string {
  return process.env.WORKBENCH_DATA_DIR ?? process.cwd();
}
