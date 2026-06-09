import type { Clearance, Role, SessionUser } from "./types";

/**
 * 本地 HTTP API 客户端。身份由服务端会话决定：登录拿到令牌后，所有请求经
 * `Authorization: Bearer <token>` 携带；服务端据此注入身份（客户端不再自报）。
 */

const BASE = "/api";

/** 模块级会话令牌，由 SessionProvider 在登录/恢复/登出时设置。 */
let sessionToken: string | null = null;

export function setSessionToken(token: string | null): void {
  sessionToken = token;
}

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

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (sessionToken) h.authorization = `Bearer ${sessionToken}`;
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

// ---- 鉴权（产品 spec §8.1） ----

export async function login(username: string, password: string): Promise<{ token: string; user: SessionUser }> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { message?: string };
  if (!res.ok || body.ok === false) throw new Error(body.message ?? `登录失败（HTTP ${res.status}）`);
  return { token: body.token as string, user: body.user as SessionUser };
}

export function fetchMe(): Promise<SessionUser> {
  return fetch(`${BASE}/auth/me`, { headers: headers() }).then((r) => unwrap<SessionUser>(r, "user"));
}

export async function logout(): Promise<void> {
  await fetch(`${BASE}/auth/logout`, { method: "POST", headers: headers() }).catch(() => undefined);
}

export function listCases(): Promise<ApiCase[]> {
  return fetch(`${BASE}/cases`, { headers: headers() }).then((r) => unwrap<ApiCase[]>(r, "cases"));
}

export function createCase(input: { name: string; clearance: Clearance }): Promise<ApiCase> {
  return fetch(`${BASE}/cases`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(input),
  }).then((r) => unwrap<ApiCase>(r, "case"));
}

export function getCase(id: string): Promise<ApiCase> {
  return fetch(`${BASE}/cases/${encodeURIComponent(id)}`, { headers: headers() }).then((r) => unwrap<ApiCase>(r, "case"));
}

export function listMaterials(caseId: string): Promise<ApiMaterial[]> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/materials`, { headers: headers() }).then((r) =>
    unwrap<ApiMaterial[]>(r, "materials"),
  );
}

export function ingestMaterials(caseId: string, files: IngestFile[]): Promise<ApiMaterial[]> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/materials`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ files }),
  }).then((r) => unwrap<ApiMaterial[]>(r, "materials"));
}

export function listInquiries(caseId: string): Promise<ApiInquiry[]> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/inquiries`, { headers: headers() }).then((r) =>
    unwrap<ApiInquiry[]>(r, "inquiries"),
  );
}

export function askInquiry(caseId: string, question: string): Promise<ApiInquiry> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/inquiries`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ question }),
  }).then((r) => unwrap<ApiInquiry>(r, "inquiry"));
}

export function getMaterialContent(materialId: string): Promise<MaterialContent> {
  return fetch(`${BASE}/materials/${encodeURIComponent(materialId)}`, { headers: headers() }).then(async (r) => {
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown> & { message?: string };
    if (!r.ok || body.ok === false) throw new Error(body.message ?? `请求失败（HTTP ${r.status}）`);
    return { material: body.material, text: body.text, chunkCount: body.chunkCount, note: body.note } as MaterialContent;
  });
}

// ---- 要素抽取 ----

export function listElements(caseId: string): Promise<ApiElement[]> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/elements`, { headers: headers() }).then((r) =>
    unwrap<ApiElement[]>(r, "elements"),
  );
}

export function extractElements(caseId: string): Promise<ApiElement[]> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/elements`, { method: "POST", headers: headers() }).then((r) =>
    unwrap<ApiElement[]>(r, "elements"),
  );
}

// ---- 报告（M4，复核闸门） ----

export function getReport(caseId: string): Promise<ApiReport | null> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/report`, { headers: headers() }).then((r) =>
    unwrap<ApiReport | null>(r, "report"),
  );
}

export function draftReport(caseId: string, input: DraftReportInput): Promise<ApiReport> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/report/draft`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(input),
  }).then((r) => unwrap<ApiReport>(r, "report"));
}

function reportAction(caseId: string, action: "submit" | "approve"): Promise<ApiReport> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/report/${action}`, { method: "POST", headers: headers() }).then(
    (r) => unwrap<ApiReport>(r, "report"),
  );
}

export const submitReport = (caseId: string) => reportAction(caseId, "submit");
export const approveReport = (caseId: string) => reportAction(caseId, "approve");

export function exportReport(caseId: string): Promise<{ filename: string; content: string; status: ReportStatus }> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/report/export`, { method: "POST", headers: headers() }).then((r) =>
    unwrap<{ filename: string; content: string; status: ReportStatus }>(r, "export"),
  );
}

// ---- 管理后台（M5） ----

export function listSkills(): Promise<ApiSkill[]> {
  return fetch(`${BASE}/admin/skills`, { headers: headers() }).then((r) => unwrap<ApiSkill[]>(r, "skills"));
}

export function setSkillEnabled(name: string, enabled: boolean): Promise<ApiSkill[]> {
  return fetch(`${BASE}/admin/skills/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ enabled }),
  }).then((r) => unwrap<ApiSkill[]>(r, "skills"));
}

export function modelDoctor(): Promise<ApiModelDoctor> {
  return fetch(`${BASE}/admin/models`, { headers: headers() }).then((r) => unwrap<ApiModelDoctor>(r, "model"));
}

export function listAdminUsers(): Promise<ApiUser[]> {
  return fetch(`${BASE}/admin/users`, { headers: headers() }).then((r) => unwrap<ApiUser[]>(r, "users"));
}

export function listPrompts(): Promise<ApiPrompt[]> {
  return fetch(`${BASE}/admin/prompts`, { headers: headers() }).then((r) => unwrap<ApiPrompt[]>(r, "prompts"));
}

export function exportAudit(): Promise<{ exportedAt: string; count: number; events: AuditEvent[] }> {
  return fetch(`${BASE}/audit/export`, { method: "POST", headers: headers() }).then(async (r) => {
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

export function listAudit(): Promise<AuditEvent[]> {
  return fetch(`${BASE}/audit`, { headers: headers() }).then((r) => unwrap<AuditEvent[]>(r, "events"));
}

export function verifyAudit(): Promise<VerifyResult> {
  return fetch(`${BASE}/audit/verify`, { headers: headers() }).then((r) => unwrap<VerifyResult>(r, "result"));
}
