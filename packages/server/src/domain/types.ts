/**
 * 共享领域类型（M1 数据底座，工程方案 §4）。
 *
 * 这些类型被持久化层、用例服务与路由共同引用。字段命名对齐工程方案 §4.2
 * 的存储表与 §7.2 的审计哈希链（`payload_hash` / `prev_hash` / `event_hash`，
 * 刻意与 Citation 的 `content_hash` 区分）。
 */

export type Role = "operator" | "admin" | "security";
export type Clearance = "internal" | "secret" | "confidential" | "topsecret";
export type CaseStatus = "active" | "archived";

/** 密级由低到高（工程方案 §11）。索引即密级序，越大越高。 */
export const CLEARANCES: readonly Clearance[] = ["internal", "secret", "confidential", "topsecret"];
export const ROLES: readonly Role[] = ["operator", "admin", "security"];

/** 密级序：可访问性比较用（高密级可见低密级）。 */
export function clearanceRank(c: Clearance): number {
  return CLEARANCES.indexOf(c);
}

/** 当前操作者身份（M1 为开发期身份，见 identity.ts）。 */
export interface Identity {
  id: string;
  name: string;
  role: Role;
  clearance: Clearance;
}

/** `cases/<id>/manifest.json`（工程方案 §4.2）。一期 materials 为空，M2 填充。 */
export interface CaseManifest {
  id: string;
  name: string;
  clearance: Clearance;
  status: CaseStatus;
  owner: string;
  created_at: string;
  updated_at: string;
  materials: unknown[];
}

export type AuditResult = "ok" | "deny" | "error";

/** `audit/audit.jsonl` 每行一条（工程方案 §4.2 / §7.2）。 */
export interface AuditEvent {
  id: string;
  ts: string;
  user: string;
  action: string;
  object: string;
  result: AuditResult;
  detail?: Record<string, unknown>;
  payload_hash: string;
  prev_hash: string;
  event_hash: string;
}
