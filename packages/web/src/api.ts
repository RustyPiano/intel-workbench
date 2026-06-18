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

/** 会话失效（任意鉴权请求返回 401）回调，由 SessionProvider 注册以自动登出回登录页。 */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

/** 鉴权请求遇 401 即触发自动登出（登录端点的 401 不走此路径）。 */
function noteStatus(res: Response): void {
  if (res.status === 401) onUnauthorized?.();
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
  duration?: number;
  processed_at?: string;
  engine?: string;
  chunk_version?: number;
}

/** 音频转写段（二期 P2.3a，done 音频素材的 getContent 返回）。 */
export interface AsrSegment {
  start: number;
  end: number;
  speaker?: string;
  text: string;
}

/** OCR 行（文本 + 归一化区域 [x,y,w,h]，二期 P2.3b）。 */
export interface OcrLine {
  text: string;
  bbox: [number, number, number, number];
}
export interface VideoShot {
  t1: number;
  t2: number;
  frameKey: string;
  caption: string | null;
  ocr: OcrLine[];
}
export interface VideoMedia {
  kind: "video";
  duration: number;
  shots: VideoShot[];
  transcript: { segments: AsrSegment[] } | null;
}
export interface ImageMedia {
  kind: "image";
  caption: string | null;
  ocr: OcrLine[];
}

export interface MaterialContent {
  material: ApiMaterial;
  text?: string;
  segments?: AsrSegment[];
  /** 视频/图像加工中间结果（二期 P2.3b）。 */
  media?: VideoMedia | ImageMedia;
  chunkCount?: number;
  note?: string;
}

export interface ApiCitation {
  material_id: string;
  material_name: string;
  modality: Modality;
  locator: { page?: number; paragraph?: number; char_start?: number; char_end?: number; timecode?: string; speaker?: string; bbox?: [number, number, number, number]; frame?: number };
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

export type ApiInquiryStreamEvent =
  | { type: "token"; text: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; ok: boolean }
  | { type: "done"; inquiry: ApiInquiry }
  | { type: "error"; message: string };

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

export interface ApiPromptVersion {
  ts: string;
  bytes: number;
}

export interface ApiPromptDetail {
  id: string;
  name: string;
  role: string;
  description: string;
  body: string;
  isDefault: boolean;
  version: number;
  healthy: boolean;
  updatedAt?: string;
  versions: ApiPromptVersion[];
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
    noteStatus(res);
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

/**
 * 流式上传单个文件（二期 §4.6，绕 25MB base64-in-JSON 上限）：请求体即文件字节。
 * 用 XHR 而非 fetch，以拿到 upload.onprogress 上传进度（fetch 无上传进度事件）。
 */
export function uploadMaterial(caseId: string, file: File, onProgress?: (fraction: number) => void): Promise<ApiMaterial> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}/cases/${encodeURIComponent(caseId)}/materials/upload`);
    if (sessionToken) xhr.setRequestHeader("authorization", `Bearer ${sessionToken}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-upload-filename", encodeURIComponent(file.name));
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.total > 0 ? e.loaded / e.total : 0);
      };
    }
    xhr.onload = () => {
      let body: Record<string, unknown> & { message?: string } = {};
      try {
        body = JSON.parse(xhr.responseText) as typeof body;
      } catch {
        /* 非 JSON 响应 → 落到下方状态判定 */
      }
      if (xhr.status === 401) onUnauthorized?.();
      if (xhr.status < 200 || xhr.status >= 300 || body.ok === false) {
        reject(new Error(body.message ?? `上传失败（HTTP ${xhr.status}）`));
        return;
      }
      resolve(body.material as ApiMaterial);
    };
    xhr.onerror = () => reject(new Error("上传失败（网络错误）"));
    xhr.send(file);
  });
}

/** 重建素材稠密索引（embed 端点恢复后手动建检索向量）。 */
export function reindexMaterial(caseId: string, materialId: string): Promise<ApiMaterial> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/materials/${encodeURIComponent(materialId)}/reindex`, {
    method: "POST",
    headers: headers(),
  }).then((r) => unwrap<ApiMaterial>(r, "material"));
}

/** 删除素材（清理落盘 + 从专题摘除）。 */
export async function deleteMaterial(caseId: string, materialId: string): Promise<void> {
  const res = await fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/materials/${encodeURIComponent(materialId)}`, {
    method: "DELETE",
    headers: headers(),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
  if (!res.ok || body.ok === false) {
    noteStatus(res);
    throw new Error(body.message ?? `删除失败（HTTP ${res.status}）`);
  }
}

/** 本专题审计链（§7.2 镜像）：可读该专题者即可查其审计轨迹。 */
export function listCaseAudit(caseId: string): Promise<AuditEvent[]> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/audit`, { headers: headers() }).then((r) =>
    unwrap<AuditEvent[]>(r, "events"),
  );
}

export function listInquiries(caseId: string): Promise<ApiInquiry[]> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/inquiries`, { headers: headers() }).then((r) =>
    unwrap<ApiInquiry[]>(r, "inquiries"),
  );
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function parseSseFrame(frame: string): ApiInquiryStreamEvent | null {
  const data = frame
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data) return null;
  try {
    return JSON.parse(data) as ApiInquiryStreamEvent;
  } catch {
    return null;
  }
}

export async function askInquiryStream(
  caseId: string,
  question: string,
  onEvent: (e: ApiInquiryStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const res = await fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/inquiries/stream`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ question }),
      signal,
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok || !contentType.toLowerCase().includes("text/event-stream")) {
      noteStatus(res);
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message || `请求失败(${res.status})`);
    }
    if (!res.body) throw new Error("流式响应为空");

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let finished = false;

    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const event = parseSseFrame(frame);
        if (!event) continue;
        onEvent(event);
        if (event.type === "done" || event.type === "error") {
          finished = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
    buffer += decoder.decode();
    if (!finished && buffer) {
      const event = parseSseFrame(buffer);
      if (event) onEvent(event);
    }
  } catch (err) {
    if (isAbortError(err)) return;
    throw err;
  }
}

export function getMaterialContent(materialId: string): Promise<MaterialContent> {
  return fetch(`${BASE}/materials/${encodeURIComponent(materialId)}`, { headers: headers() }).then(async (r) => {
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown> & { message?: string };
    if (!r.ok || body.ok === false) {
      noteStatus(r);
      throw new Error(body.message ?? `请求失败（HTTP ${r.status}）`);
    }
    return { material: body.material, text: body.text, segments: body.segments, media: body.media, chunkCount: body.chunkCount, note: body.note } as MaterialContent;
  });
}

/** 拉取视频/图像关键帧为对象 URL（带令牌，供 bbox 框选回放，二期 §4.3）。调用方负责 revoke。 */
export async function fetchFrameUrl(materialId: string, t: number | string): Promise<string> {
  const res = await fetch(`${BASE}/materials/${encodeURIComponent(materialId)}/frame?t=${encodeURIComponent(String(t))}`, { headers: headers() });
  if (!res.ok) {
    noteStatus(res);
    throw new Error(`帧加载失败（HTTP ${res.status}）`);
  }
  return URL.createObjectURL(await res.blob());
}

/** 显式加工媒体素材（二期 P2.3a）：pending/failed/done → done|failed。 */
export function processMaterial(caseId: string, materialId: string): Promise<ApiMaterial> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/materials/${encodeURIComponent(materialId)}/process`, {
    method: "POST",
    headers: headers(),
  }).then((r) => unwrap<ApiMaterial>(r, "material"));
}

/** 拉取原始素材为对象 URL，供音频回放（带会话令牌，故不能直接用 <audio src>）。调用方负责 revoke。 */
export async function fetchMaterialRawUrl(materialId: string): Promise<string> {
  const res = await fetch(`${BASE}/materials/${encodeURIComponent(materialId)}/raw`, { headers: headers() });
  if (!res.ok) {
    noteStatus(res);
    throw new Error(`回放加载失败（HTTP ${res.status}）`);
  }
  return URL.createObjectURL(await res.blob());
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

export function createUser(input: { id: string; name: string; role: Role; clearance: Clearance; password: string }): Promise<ApiUser> {
  return fetch(`${BASE}/admin/users`, { method: "POST", headers: headers(true), body: JSON.stringify(input) }).then((r) =>
    unwrap<ApiUser>(r, "user"),
  );
}

export function updateUser(
  id: string,
  patch: { name?: string; role?: Role; clearance?: Clearance; enabled?: boolean },
): Promise<ApiUser> {
  return fetch(`${BASE}/admin/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: headers(true),
    body: JSON.stringify(patch),
  }).then((r) => unwrap<ApiUser>(r, "user"));
}

export async function resetUserPassword(id: string, password: string): Promise<void> {
  const res = await fetch(`${BASE}/admin/users/${encodeURIComponent(id)}/password`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ password }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
  if (!res.ok || body.ok === false) {
    noteStatus(res);
    throw new Error(body.message ?? `请求失败（HTTP ${res.status}）`);
  }
}

export function listPrompts(): Promise<ApiPrompt[]> {
  return fetch(`${BASE}/admin/prompts`, { headers: headers() }).then((r) => unwrap<ApiPrompt[]>(r, "prompts"));
}

export function getPromptDetail(id: string): Promise<ApiPromptDetail> {
  return fetch(`${BASE}/admin/prompts/${encodeURIComponent(id)}`, { headers: headers() }).then((r) =>
    unwrap<ApiPromptDetail>(r, "prompt"),
  );
}

export async function updatePrompt(id: string, body: string): Promise<void> {
  const res = await fetch(`${BASE}/admin/prompts/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: headers(true),
    body: JSON.stringify({ body }),
  });
  await unwrap<boolean>(res, "ok");
}

export function getPromptVersion(id: string, ts: string): Promise<string> {
  return fetch(`${BASE}/admin/prompts/${encodeURIComponent(id)}/versions/${encodeURIComponent(ts)}`, { headers: headers() }).then(
    (r) => unwrap<string>(r, "body"),
  );
}

export function exportAudit(): Promise<{ exportedAt: string; count: number; events: AuditEvent[] }> {
  return fetch(`${BASE}/audit/export`, { method: "POST", headers: headers() }).then(async (r) => {
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown> & { message?: string };
    if (!r.ok || body.ok === false) {
      noteStatus(r);
      throw new Error(body.message ?? `请求失败（HTTP ${r.status}）`);
    }
    return { exportedAt: body.exportedAt, count: body.count, events: body.events } as { exportedAt: string; count: number; events: AuditEvent[] };
  });
}

export function listAudit(): Promise<AuditEvent[]> {
  return fetch(`${BASE}/audit`, { headers: headers() }).then((r) => unwrap<AuditEvent[]>(r, "events"));
}

export function verifyAudit(): Promise<VerifyResult> {
  return fetch(`${BASE}/audit/verify`, { headers: headers() }).then((r) => unwrap<VerifyResult>(r, "result"));
}
