import type { Clearance, SessionUser } from "./types";

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
