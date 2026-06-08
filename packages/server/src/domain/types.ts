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

export const CLEARANCE_LABELS: Record<Clearance, string> = {
  internal: "内部",
  secret: "秘密",
  confidential: "机密",
  topsecret: "绝密",
};

/** 当前操作者身份（M1 为开发期身份，见 identity.ts）。 */
export interface Identity {
  id: string;
  name: string;
  role: Role;
  clearance: Clearance;
}

/** 素材模态（产品 spec §5.2）。一期仅文档可加工，其余降级占位。 */
export type Modality = "doc" | "audio" | "video" | "image";
/** 加工状态机：待加工 / 加工中 / 已完成 / 失败（产品 spec §5.2）。 */
export type MaterialStatus = "pending" | "processing" | "done" | "failed";

/** 素材元数据（产品 spec §5.2，记入 manifest.materials）。 */
export interface Material {
  id: string;
  case_id: string;
  filename: string;
  modality: Modality;
  format: string;
  size: number;
  ingested_at: string;
  status: MaterialStatus;
  language?: string;
  /** 文档加工完成后的切块数（§7.3）。 */
  chunk_count?: number;
  /** 降级 / 失败原因（产品 spec §10）。 */
  note?: string;
}

/** 切块（汇入时，工程方案 §7.3 step 1）。存 `processed/<mid>.chunks.jsonl`。 */
export interface Chunk {
  chunk_id: string;
  material_id: string;
  locator: { page?: number; paragraph?: number };
  text: string;
  content_hash: string;
}

/** 溯源引用（工程方案 §4.3）。指向被检索出的素材片段。 */
export interface Citation {
  material_id: string;
  material_name: string;
  modality: Modality;
  locator: { page?: number; paragraph?: number; timecode?: string; bbox?: [number, number, number, number] };
  snippet: string;
  confidence: number;
  /** 指向素材内容（≠ 审计 event_hash，§7.2）。 */
  content_hash: string;
}

/** 单条结论。校验不通过降级为"待核"（unverified，§7.3 step 4）。 */
export interface InquiryClaim {
  text: string;
  type: "fact" | "inference";
  status: "verified" | "unverified";
  citations: Citation[];
}

/** 问答记录（落 `cases/<id>/inquiries.jsonl`，§7.3 step 5）。 */
export interface Inquiry {
  id: string;
  ts: string;
  user: string;
  question: string;
  /** answered=有据回答；insufficient=材料不足；error=模型调用失败/降级。 */
  status: "answered" | "insufficient" | "error";
  answer: string;
  claims: InquiryClaim[];
}

/** 要素类型（产品 spec §5.2）。 */
export type ElementType = "person" | "org" | "location" | "event" | "equipment" | "time";

/** 情报要素（产品 spec §5.2）。mentions = 提及，每条指回素材出处（即 Citation）。 */
export interface Element {
  id: string;
  type: ElementType;
  name: string;
  aliases: string[];
  mentions: Citation[];
  /** 出现次数 = 有效提及数。 */
  freq: number;
  note?: string;
}

/** 报告复核状态机（工程方案 §7.4）：草稿 → 待复核 → 已复核 → 已导出。 */
export type ReportStatus = "draft" | "in_review" | "approved" | "exported";

export interface BulletinSection {
  heading: string;
  body: string;
}

/** 通报 spec（喂 intel-bulletin render_report.py，§3）。 */
export interface BulletinSpec {
  title: string;
  doc_number?: string;
  classification?: string;
  recipient?: string;
  summary?: string;
  sections: BulletinSection[];
  conclusion?: string;
  issuer?: string;
  date?: string;
}

/** `cases/<id>/report/report.json`：报告状态机 + spec + 复核痕迹（§7.4）。 */
export interface ReportRecord {
  status: ReportStatus;
  spec: BulletinSpec;
  drafted_by: string;
  drafted_at: string;
  submitted_by?: string;
  submitted_at?: string;
  reviewed_by?: string;
  approved_at?: string;
  exported_by?: string;
  exported_at?: string;
  /** bulletin.md 是否已渲染。 */
  rendered: boolean;
}

/** `cases/<id>/manifest.json`（工程方案 §4.2）。 */
export interface CaseManifest {
  id: string;
  name: string;
  clearance: Clearance;
  status: CaseStatus;
  owner: string;
  created_at: string;
  updated_at: string;
  materials: Material[];
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
