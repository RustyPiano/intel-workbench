import type { Clearance, Role, SessionUser } from "./types";

/**
 * 本地 HTTP API 客户端（M1）。开发期身份经请求头注入（仅 ASCII），
 * 真正的登录 / 会话在 M5 接通 `POST /api/auth/login`。
 */

const BASE = "/api";

export interface ApiCase {
  id: string;
  name: string;
  clearance: Clearance;
  status: "active" | "archived";
  owner: string;
  created_at: string;
  updated_at: string;
  materials: unknown[];
}

export interface AuditEvent {
  id: string;
  ts: string;
  user: string;
  action: string;
  object: string;
  result: "ok" | "deny" | "error";
  detail?: Record<string, unknown>;
  payload_hash: string;
  prev_hash: string;
  event_hash: string;
}

export interface VerifyResult {
  ok: boolean;
  count: number;
  brokenAt?: number;
  reason?: string;
}

export type Modality = "doc" | "audio" | "video" | "image";
export type MaterialStatus = "pending" | "processing" | "done" | "failed";

export interface ApiMaterial {
  id: string;
  case_id: string;
  filename: string;
  modality: Modality;
  format: string;
  size: number;
  ingested_at: string;
  status: MaterialStatus;
  language?: string;
  chunk_count?: number;
  note?: string;
}

export interface MaterialContent {
  material: ApiMaterial;
  text?: string;
  chunkCount?: number;
  note?: string;
}

export interface IngestFile {
  filename: string;
  content: string;
  encoding: "utf8" | "base64";
}

export interface ApiCitation {
  material_id: string;
  material_name: string;
  modality: Modality;
  locator: { page?: number; paragraph?: number; timecode?: string; bbox?: [number, number, number, number] };
  snippet: string;
  confidence: number;
  content_hash: string;
}

export interface ApiClaim {
  text: string;
  type: "fact" | "inference";
  status: "verified" | "unverified";
  citations: ApiCitation[];
}

export interface ApiInquiry {
  id: string;
  ts: string;
  user: string;
  question: string;
  status: "answered" | "insufficient" | "error";
  answer: string;
  claims: ApiClaim[];
}

export type ElementType = "person" | "org" | "location" | "event" | "equipment" | "time";

export interface ApiElement {
  id: string;
  type: ElementType;
  name: string;
  aliases: string[];
  mentions: ApiCitation[];
  freq: number;
  note?: string;
}

export type ReportStatus = "draft" | "in_review" | "approved" | "exported";

export interface ApiReport {
  status: ReportStatus;
  spec: {
    title: string;
    classification?: string;
    summary?: string;
    sections: { heading: string; body: string }[];
    conclusion?: string;
    issuer?: string;
    date?: string;
  };
  drafted_by: string;
  drafted_at: string;
  submitted_by?: string;
  reviewed_by?: string;
  exported_by?: string;
  rendered: boolean;
}

export interface DraftReportInput {
  title: string;
  body?: string;
  summary?: string;
  conclusion?: string;
}

export interface ApiSkill {
  name: string;
  description: string;
  enabled: boolean;
  healthy: boolean;
}

export interface ApiModelDoctor {
  configured: boolean;
  provider: string;
  model: string;
  host: string;
  allowlisted: boolean;
}

export interface ApiUser {
  id: string;
  name: string;
  role: Role;
  clearance: Clearance;
  enabled: boolean;
}

export interface ApiPrompt {
  id: string;
  name: string;
  role: string;
  description: string;
}

function headers(user: SessionUser, json = false): Record<string, string> {
  const h: Record<string, string> = {
    "x-user-id": user.id,
    "x-user-role": user.role,
    "x-user-clearance": user.clearance,
  };
  if (json) h["content-type"] = "application/json";
  return h;
}

async function unwrap<T>(res: Response, key: string): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { message?: string };
  if (!res.ok || body.ok === false) {
    throw new Error(body.message ?? `请求失败（HTTP ${res.status}）`);
  }
  return body[key] as T;
}

export function listCases(user: SessionUser): Promise<ApiCase[]> {
  return fetch(`${BASE}/cases`, { headers: headers(user) }).then((r) => unwrap<ApiCase[]>(r, "cases"));
}

export function createCase(user: SessionUser, input: { name: string; clearance: Clearance }): Promise<ApiCase> {
  return fetch(`${BASE}/cases`, {
    method: "POST",
    headers: headers(user, true),
    body: JSON.stringify(input),
  }).then((r) => unwrap<ApiCase>(r, "case"));
}

export function getCase(user: SessionUser, id: string): Promise<ApiCase> {
  return fetch(`${BASE}/cases/${encodeURIComponent(id)}`, { headers: headers(user) }).then((r) => unwrap<ApiCase>(r, "case"));
}

export function listMaterials(user: SessionUser, caseId: string): Promise<ApiMaterial[]> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/materials`, { headers: headers(user) }).then((r) =>
    unwrap<ApiMaterial[]>(r, "materials"),
  );
}

export function ingestMaterials(user: SessionUser, caseId: string, files: IngestFile[]): Promise<ApiMaterial[]> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/materials`, {
    method: "POST",
    headers: headers(user, true),
    body: JSON.stringify({ files }),
  }).then((r) => unwrap<ApiMaterial[]>(r, "materials"));
}

export function listInquiries(user: SessionUser, caseId: string): Promise<ApiInquiry[]> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/inquiries`, { headers: headers(user) }).then((r) =>
    unwrap<ApiInquiry[]>(r, "inquiries"),
  );
}

export function askInquiry(user: SessionUser, caseId: string, question: string): Promise<ApiInquiry> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/inquiries`, {
    method: "POST",
    headers: headers(user, true),
    body: JSON.stringify({ question }),
  }).then((r) => unwrap<ApiInquiry>(r, "inquiry"));
}

export function getMaterialContent(user: SessionUser, materialId: string): Promise<MaterialContent> {
  return fetch(`${BASE}/materials/${encodeURIComponent(materialId)}`, { headers: headers(user) }).then(async (r) => {
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown> & { message?: string };
    if (!r.ok || body.ok === false) throw new Error(body.message ?? `请求失败（HTTP ${r.status}）`);
    return { material: body.material, text: body.text, chunkCount: body.chunkCount, note: body.note } as MaterialContent;
  });
}

// ---- 要素抽取 ----

export function listElements(user: SessionUser, caseId: string): Promise<ApiElement[]> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/elements`, { headers: headers(user) }).then((r) =>
    unwrap<ApiElement[]>(r, "elements"),
  );
}

export function extractElements(user: SessionUser, caseId: string): Promise<ApiElement[]> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/elements`, { method: "POST", headers: headers(user) }).then((r) =>
    unwrap<ApiElement[]>(r, "elements"),
  );
}

// ---- 报告（M4，复核闸门） ----

export function getReport(user: SessionUser, caseId: string): Promise<ApiReport | null> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/report`, { headers: headers(user) }).then((r) =>
    unwrap<ApiReport | null>(r, "report"),
  );
}

export function draftReport(user: SessionUser, caseId: string, input: DraftReportInput): Promise<ApiReport> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/report/draft`, {
    method: "POST",
    headers: headers(user, true),
    body: JSON.stringify(input),
  }).then((r) => unwrap<ApiReport>(r, "report"));
}

function reportAction(user: SessionUser, caseId: string, action: "submit" | "approve"): Promise<ApiReport> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/report/${action}`, { method: "POST", headers: headers(user) }).then(
    (r) => unwrap<ApiReport>(r, "report"),
  );
}

export const submitReport = (user: SessionUser, caseId: string) => reportAction(user, caseId, "submit");
export const approveReport = (user: SessionUser, caseId: string) => reportAction(user, caseId, "approve");

export function exportReport(user: SessionUser, caseId: string): Promise<{ filename: string; content: string; status: ReportStatus }> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/report/export`, { method: "POST", headers: headers(user) }).then((r) =>
    unwrap<{ filename: string; content: string; status: ReportStatus }>(r, "export"),
  );
}

// ---- 管理后台（M5） ----

export function listSkills(user: SessionUser): Promise<ApiSkill[]> {
  return fetch(`${BASE}/admin/skills`, { headers: headers(user) }).then((r) => unwrap<ApiSkill[]>(r, "skills"));
}

export function setSkillEnabled(user: SessionUser, name: string, enabled: boolean): Promise<ApiSkill[]> {
  return fetch(`${BASE}/admin/skills/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: headers(user, true),
    body: JSON.stringify({ enabled }),
  }).then((r) => unwrap<ApiSkill[]>(r, "skills"));
}

export function modelDoctor(user: SessionUser): Promise<ApiModelDoctor> {
  return fetch(`${BASE}/admin/models`, { headers: headers(user) }).then((r) => unwrap<ApiModelDoctor>(r, "model"));
}

export function listAdminUsers(user: SessionUser): Promise<ApiUser[]> {
  return fetch(`${BASE}/admin/users`, { headers: headers(user) }).then((r) => unwrap<ApiUser[]>(r, "users"));
}

export function listPrompts(user: SessionUser): Promise<ApiPrompt[]> {
  return fetch(`${BASE}/admin/prompts`, { headers: headers(user) }).then((r) => unwrap<ApiPrompt[]>(r, "prompts"));
}

export function exportAudit(user: SessionUser): Promise<{ exportedAt: string; count: number; events: AuditEvent[] }> {
  return fetch(`${BASE}/audit/export`, { method: "POST", headers: headers(user) }).then(async (r) => {
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown> & { message?: string };
    if (!r.ok || body.ok === false) throw new Error(body.message ?? `请求失败（HTTP ${r.status}）`);
    return { exportedAt: body.exportedAt, count: body.count, events: body.events } as { exportedAt: string; count: number; events: AuditEvent[] };
  });
}

/** 浏览器侧读取文件：文本走 utf8，其余走 base64（媒体在服务端降级）。 */
const TEXT_EXTS = new Set(["txt", "md", "markdown", "text", "csv", "tsv", "log", "json", "yaml", "yml", "htm", "html"]);

export function readFileForUpload(file: File): Promise<IngestFile> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const isText = TEXT_EXTS.has(ext);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    if (isText) {
      reader.onload = () => resolve({ filename: file.name, content: String(reader.result), encoding: "utf8" });
      reader.readAsText(file);
    } else {
      reader.onload = () => resolve({ filename: file.name, content: String(reader.result).split(",")[1] ?? "", encoding: "base64" });
      reader.readAsDataURL(file);
    }
  });
}

export function listAudit(user: SessionUser): Promise<AuditEvent[]> {
  return fetch(`${BASE}/audit`, { headers: headers(user) }).then((r) => unwrap<AuditEvent[]>(r, "events"));
}

export function verifyAudit(user: SessionUser): Promise<VerifyResult> {
  return fetch(`${BASE}/audit/verify`, { headers: headers(user) }).then((r) => unwrap<VerifyResult>(r, "result"));
}
