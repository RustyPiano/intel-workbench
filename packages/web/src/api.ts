import type { Clearance, Role, SessionUser } from "./types";

/**
 * 本地 HTTP API 客户端。身份由服务端会话决定：登录拿到令牌后，所有请求经
 * `Authorization: Bearer <token>` 携带；服务端据此注入身份（客户端不再自报）。
 */

const BASE = "/api";

/**
 * 会话令牌仅存于内存（模块级变量）。持久化（跨刷新恢复）由 SessionProvider
 * 独占负责（见 state/session.tsx 的 sessionStorage 读写），此处不再重复存储。
 */
let sessionToken: string | null = null;

function getSessionToken(): string | null {
  return sessionToken;
}

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
  /** 专题说明（选填，产品 spec §5.2 / §8.3）。 */
  description?: string;
  status: "active" | "archived";
  owner: string;
  created_at: string;
  updated_at: string;
  materials: unknown[];
  autopilot?: boolean;
}

export interface OverviewCaseRow {
  id: string;
  name: string;
  clearance: Clearance;
  status: "active" | "archived";
  materialCount: number;
  materials: MaterialStatusCounts;
  elementCount: number;
  contradictionCount: number;
  reportStatus: ReportStatus | null;
  updated_at: string;
}

export interface OverviewSummary {
  caseCount: number;
  activeCount: number;
  archivedCount: number;
  materialCount: number;
  materialsByModality: Record<Modality, number>;
  elementCount: number;
  contradictionCount: number;
  byClearance: Record<Clearance, number>;
  rows: OverviewCaseRow[];
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
export type MaterialStatusCounts = Record<MaterialStatus, number> & { needsConfig: number };

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
  locator: { page?: number; paragraph?: number; char_start?: number; char_end?: number; timecode?: string; speaker?: string; bbox?: [number, number, number, number]; artifact_hash?: string; frame?: number };
  snippet: string;
  confidence: number;
  content_hash: string;
  quote?: string;
  quote_char_start?: number;
  quote_char_end?: number;
  quote_hash?: string;
  support_label?: "supports" | "mentions" | "contradicts" | "context-only" | "unknown";
  support_status?: "supported" | "support-unverified" | "unsupported";
}

export interface ApiClaim {
  text: string;
  type: "fact" | "inference";
  status: "verified" | "unverified";
  support_status?: "supported" | "support-unverified" | "unsupported";
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

/** 工具结果明细（检索类命中列表 / 阅读类原文预览），随 tool_result 下发。 */
export type ApiToolDetail =
  | { kind: "hits"; hits: { material_name: string; snippet: string }[] }
  | { kind: "text"; text: string };

/**
 * 补充核验流式事件（事件协议 v2，server 与 web 逐字一致）。
 * 前向兼容：消费方须静默忽略未知 type；thinking 亦可整场缺失（模型不出思维链）。
 */
export type ApiInquiryStreamEvent =
  | { type: "token"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "tool_start"; call_id: string; name: string; title: string; args_summary: string }
  | { type: "tool_result"; call_id: string; name: string; ok: boolean; summary: string; detail?: ApiToolDetail; elapsed_ms: number }
  | { type: "cite_added"; cite_id: string; material_name: string; quote: string }
  | { type: "claim_added"; claim_index: number; total: number; text: string; cite_ids: string[] }
  | { type: "finding_submitted"; conclusion: string; severity?: "low" | "medium" | "high"; supporting: number; opposing: number }
  | { type: "budget"; read_bytes: number; budget_bytes: number; turn?: number; max_turns?: number }
  | { type: "done"; inquiry: ApiInquiry; run_id?: string }
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

export interface Contradiction {
  id: string;
  entity: string;
  attribute?: string;
  normalized_entity?: string;
  normalized_attribute?: string;
  value_a?: string;
  value_b?: string;
  rule_source?: "rule" | "llm";
  rule_name?: string;
  scope: "cross-material" | "intra-material";
  claim_a: { text: string; citation: ApiCitation };
  claim_b: { text: string; citation: ApiCitation };
  relation: "contradiction";
  rationale: string;
  confidence: number;
}

export interface GroundedProposition {
  entity: string;
  attribute: string;
  value: string;
  normalized_entity: string;
  normalized_attribute: string;
  normalized_value: string;
  chunk_id: string;
  material_id: string;
  citation: ApiCitation;
  text: string;
}

export type ContradictionAcknowledgementStatus = "open" | "resolved" | "dismissed";
export interface ContradictionAcknowledgement {
  id: string;
  case_id: string;
  contradiction_id: string;
  status: ContradictionAcknowledgementStatus;
  note: string;
  by: string;
  at: string;
}

export type ContradictionStatus = "succeeded" | "degraded" | "failed";
export interface ContradictionDetectionResult {
  status: ContradictionStatus;
  contradictions: Contradiction[];
  groundedPropositions: GroundedProposition[];
  processedChunks: number;
  totalChunks: number;
  truncated: boolean;
  warnings: string[];
  error?: string;
  notStarted?: boolean;
  acknowledgements?: ContradictionAcknowledgement[];
}

export type FindingReviewStatus = "draft" | "approved" | "rejected";
export interface ApiFinding {
  id: string;
  caseId: string;
  conclusion: string;
  supporting_citations: ApiCitation[];
  opposing_citations: ApiCitation[];
  confidence: number;
  review_status: FindingReviewStatus;
  reviewed_by?: string;
  reviewed_at?: string;
  open_questions: string[];
}

export type ReportStatus = "draft" | "in_review" | "approved" | "exported";

export interface ApiReport {
  status: ReportStatus;
  spec: {
    title: string;
    classification?: string;
    summary?: string;
    sections: {
      heading: string;
      body: string;
      finding_ids?: string[];
      citation_ids?: string[];
      coverage_status?: "covered" | "uncovered";
      key_conclusion?: boolean;
    }[];
    conclusion?: string;
    issuer?: string;
    date?: string;
  };
  drafted_by: string;
  drafted_at: string;
  submitted_by?: string;
  submitted_at?: string;
  reviewed_by?: string;
  approved_at?: string;
  exported_by?: string;
  exported_at?: string;
  rendered: boolean;
}

export type TaskRunStatus = "active" | "done" | "failed";
export type TaskStageStatus = "pending" | "active" | "done" | "failed" | "skipped";
export type TaskAdvanceStatus = "done" | "failed" | "skipped";

export interface ApiTaskStageDef {
  key: string;
  name: string;
  checkpoint?: boolean;
}

export interface ApiTaskTemplate {
  id: string;
  name: string;
  stages: ApiTaskStageDef[];
}

export interface ApiTaskStageState {
  key: string;
  name: string;
  status: TaskStageStatus;
  checkpoint?: boolean;
  confirmedBy?: string;
  confirmedAt?: string;
}

export interface ApiTaskRun {
  id: string;
  caseId: string;
  templateId: string;
  status: TaskRunStatus;
  stages: ApiTaskStageState[];
  createdAt: string;
  completedAt?: string;
  failedAt?: string;
  updatedAt?: string;
  failureReason?: string;
}

export interface ApiTaskRunOverview {
  currentStage: ApiTaskStageState | null;
  completedStageCount: number;
  totalStageCount: number;
  pendingCheckpointCount: number;
  materials: { total: number } & MaterialStatusCounts;
  highSeverityContradictionCount: number;
  reportStatus: ReportStatus | null;
}

export interface ApiTaskRunSnapshot {
  template: ApiTaskTemplate;
  run: ApiTaskRun;
  overview: ApiTaskRunOverview;
}

export interface DraftReportInput {
  title: string;
  body?: string;
  summary?: string;
  conclusion?: string;
  finding_ids?: string[];
  sections?: {
    heading?: string;
    body?: string;
    finding_ids?: string[];
    citation_ids?: string[];
    coverage_status?: "covered" | "uncovered";
    key_conclusion?: boolean;
  }[];
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
  const token = getSessionToken();
  if (token) h.authorization = `Bearer ${token}`;
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

export interface ApiRuntimeStatus {
  ok: true;
  devMode: boolean;
  networkMode: "offline" | "restricted-cloud";
  modelConfigured: boolean;
}

/** 公开、非敏感的实际运行状态，供顶栏诚实展示。 */
export async function getRuntimeStatus(signal?: AbortSignal): Promise<ApiRuntimeStatus> {
  const res = await fetch(`${BASE}/health`, { signal });
  const body = (await res.json().catch(() => ({}))) as Partial<ApiRuntimeStatus> & { message?: string };
  if (!res.ok || body.ok !== true) throw new Error(body.message ?? `运行状态请求失败（HTTP ${res.status}）`);
  return body as ApiRuntimeStatus;
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

export function changePassword(currentPassword: string, newPassword: string): Promise<SessionUser> {
  return fetch(`${BASE}/auth/change-password`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ currentPassword, newPassword }),
  }).then((r) => unwrap<SessionUser>(r, "user"));
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

export function getOverview(): Promise<OverviewSummary> {
  return fetch(`${BASE}/overview`, { headers: headers() }).then((r) => unwrap<OverviewSummary>(r, "overview"));
}

export function createCase(input: { name: string; clearance: Clearance; description?: string }): Promise<ApiCase> {
  return fetch(`${BASE}/cases`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(input),
  }).then((r) => unwrap<ApiCase>(r, "case"));
}

export function getCase(id: string): Promise<ApiCase> {
  return fetch(`${BASE}/cases/${encodeURIComponent(id)}`, { headers: headers() }).then((r) => unwrap<ApiCase>(r, "case"));
}

/** 更新专题（归档/恢复、自动流水线开关，`PATCH /api/cases/:id`；仅创建者或 admin 可调）。 */
export function updateCase(id: string, patch: { name?: string; status?: ApiCase["status"]; autopilot?: boolean }): Promise<ApiCase> {
  return fetch(`${BASE}/cases/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: headers(true),
    body: JSON.stringify(patch),
  }).then((r) => unwrap<ApiCase>(r, "case"));
}

export function listMaterials(caseId: string): Promise<ApiMaterial[]> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/materials`, { headers: headers() }).then((r) =>
    unwrap<ApiMaterial[]>(r, "materials"),
  );
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

const BATCH_UPLOAD_MAX_RAW_BYTES = 18 * 1024 * 1024;

/**
 * 真正的批量汇入：整批文件一次交给 `/materials`，服务端在全部摄入后才触发
 * autopilot。小批次走 JSON/base64 单请求；超过 body 上限时逐件流式上传，
 * 但每件都标记 defer，最后再 settle 一次，避免 autopilot 在批中提前启动。
 */
export async function uploadMaterialsBatch(
  caseId: string,
  files: readonly File[],
  onPrepared?: (file: File, index: number, total: number) => void,
): Promise<ApiMaterial[]> {
  if (files.length === 0) return [];
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > BATCH_UPLOAD_MAX_RAW_BYTES) {
    const uploaded: ApiMaterial[] = [];
    const failures: string[] = [];
    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        onPrepared?.(file, index + 1, files.length);
        try {
          uploaded.push(await uploadMaterial(caseId, file, undefined, true));
        } catch (e) {
          failures.push(`${file.name}：${(e as Error).message}`);
        }
      }
    } finally {
      await settleMaterialBatch(caseId);
    }
    if (failures.length > 0) throw new Error(`${failures.length} 个文件上传失败；${failures.join("；")}`);
    return uploaded;
  }
  const payload: { filename: string; content: string; encoding: "base64" }[] = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    payload.push({ filename: file.name, content: await fileToBase64(file), encoding: "base64" });
    onPrepared?.(file, index + 1, files.length);
  }
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/materials`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ files: payload }),
  }).then((r) => unwrap<ApiMaterial[]>(r, "materials"));
}

/**
 * 流式上传单个文件（二期 §4.6，绕 25MB base64-in-JSON 上限）：请求体即文件字节。
 * 用 XHR 而非 fetch，以拿到 upload.onprogress 上传进度（fetch 无上传进度事件）。
 */
export function uploadMaterial(
  caseId: string,
  file: File,
  onProgress?: (fraction: number) => void,
  deferBatch = false,
): Promise<ApiMaterial> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}/cases/${encodeURIComponent(caseId)}/materials/upload`);
    const token = getSessionToken();
    if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-upload-filename", encodeURIComponent(file.name));
    if (deferBatch) xhr.setRequestHeader("x-upload-batch", "defer");
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

async function settleMaterialBatch(caseId: string): Promise<void> {
  const res = await fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/materials/settle`, {
    method: "POST",
    headers: headers(),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
  if (!res.ok || body.ok === false) {
    noteStatus(res);
    throw new Error(body.message ?? `批量素材收口失败（HTTP ${res.status}）`);
  }
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

/** 标记一条低置信项为已人工校对（§9.2，写审计 review.mark）。 */
export async function markReview(caseId: string, ref: string): Promise<void> {
  const res = await fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/review`, { method: "POST", headers: headers(true), body: JSON.stringify({ ref }) });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
  if (!res.ok || body.ok === false) {
    noteStatus(res);
    throw new Error(body.message ?? `校对标记失败（HTTP ${res.status}）`);
  }
}

export function listInquiries(caseId: string): Promise<ApiInquiry[]> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/inquiries`, { headers: headers() }).then((r) =>
    unwrap<ApiInquiry[]>(r, "inquiries"),
  );
}

export async function clearInquiries(caseId: string): Promise<void> {
  const res = await fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/inquiries`, { method: "DELETE", headers: headers() });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
  if (!res.ok || body.ok === false) {
    noteStatus(res);
    throw new Error(body.message ?? `清空失败（HTTP ${res.status}）`);
  }
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
  deep = false,
): Promise<void> {
  try {
    const res = await fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/inquiries/stream`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ question, deep }),
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

export interface ElementGraphNode { id: string; name: string; type: ElementType; freq: number; degree: number; }
export interface ElementGraphEdge { source: string; target: string; weight: number; citations: ApiCitation[]; }
export interface TimelinePoint { id: string; label: string; sortKey: number | null; related: { id: string; name: string; type: ElementType }[]; citations: ApiCitation[]; }
export interface ElementGraph { nodes: ElementGraphNode[]; edges: ElementGraphEdge[]; timeline: TimelinePoint[]; anchored: boolean; truncated: boolean; }

export function getElementGraph(caseId: string): Promise<ElementGraph> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/element-graph`, { headers: headers() }).then((r) => unwrap<ElementGraph>(r, "graph"));
}

// ---- 矛盾检测 ----

export function listContradictions(caseId: string): Promise<ContradictionDetectionResult> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/contradictions`, { headers: headers() }).then((r) =>
    unwrap<ContradictionDetectionResult>(r, "result"),
  );
}

export function detectContradictions(caseId: string): Promise<ContradictionDetectionResult> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/contradictions`, { method: "POST", headers: headers() }).then((r) =>
    unwrap<ContradictionDetectionResult>(r, "result"),
  );
}

export function acknowledgeContradiction(caseId: string, contradictionId: string, input: { status: ContradictionAcknowledgementStatus; note: string }): Promise<ContradictionAcknowledgement> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/contradictions/${encodeURIComponent(contradictionId)}/acknowledge`, {
    method: "PATCH",
    headers: headers(true),
    body: JSON.stringify(input),
  }).then((r) => unwrap<ContradictionAcknowledgement>(r, "acknowledgement"));
}

// ---- Findings（Batch E） ----

export function listFindings(caseId: string): Promise<ApiFinding[]> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/findings`, { headers: headers() }).then((r) =>
    unwrap<ApiFinding[]>(r, "findings"),
  );
}

export function createFinding(caseId: string, input: { claim?: ApiClaim; conclusion?: string; supporting_citations?: ApiCitation[]; opposing_citations?: ApiCitation[]; confidence?: number }): Promise<ApiFinding> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/findings`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(input),
  }).then((r) => unwrap<ApiFinding>(r, "finding"));
}

export function reviewFinding(caseId: string, findingId: string, review_status: Extract<FindingReviewStatus, "approved" | "rejected">): Promise<ApiFinding> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/findings/${encodeURIComponent(findingId)}/review`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ review_status }),
  }).then((r) => unwrap<ApiFinding>(r, "finding"));
}

// ---- 建议引擎（阶段 1 规则驱动 + 阶段 2 LLM 增强） ----

export type QuestionSuggestionCategory = "basic" | "timeline" | "relationship" | "contradiction" | "verification" | "analysis";

export interface ApiQuestionSuggestion {
  category: QuestionSuggestionCategory;
  question: string;
  rationale: string;
  priority: number;
}

export type FindingSuggestionSource = "inquiry" | "contradiction" | "element-timeline" | "inquiry-structured";

export interface ApiFindingSuggestion {
  id: string;
  source: FindingSuggestionSource;
  conclusion: string;
  supporting_citations: ApiCitation[];
  opposing_citations: ApiCitation[];
  confidence: number;
  reasoning: string;
  autoGenerated: boolean;
}

export interface ApiGenerateFindingSuggestionsResult {
  suggestions: ApiFindingSuggestion[];
  questions: string[];
  inquiriesCreated: number;
  skippedExisting: number;
}

export function getSuggestedQuestions(caseId: string): Promise<ApiQuestionSuggestion[]> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/suggestions/questions`, { headers: headers() }).then((r) =>
    unwrap<ApiQuestionSuggestion[]>(r, "suggestions"),
  );
}

/** LLM 增强问题推荐（决策文档 §阶段 2.3）：LLM 未配置/调用失败时服务端已静默降级为纯规则建议，本函数无需额外兜底。 */
export function getSuggestedQuestionsLLM(caseId: string): Promise<ApiQuestionSuggestion[]> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/suggestions/questions-llm`, { headers: headers() }).then((r) =>
    unwrap<ApiQuestionSuggestion[]>(r, "suggestions"),
  );
}

export function getSuggestedFindings(caseId: string): Promise<ApiFindingSuggestion[]> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/suggestions/findings`, { headers: headers() }).then((r) =>
    unwrap<ApiFindingSuggestion[]>(r, "suggestions"),
  );
}

export function generateFindingSuggestions(caseId: string): Promise<ApiGenerateFindingSuggestionsResult> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/suggestions/findings/generate`, {
    method: "POST",
    headers: headers(),
  }).then(async (r) => {
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown> & { message?: string };
    if (!r.ok || body.ok === false) {
      noteStatus(r);
      throw new Error(body.message ?? `请求失败（HTTP ${r.status}）`);
    }
    return {
      suggestions: body.suggestions as ApiFindingSuggestion[],
      questions: body.questions as string[],
      inquiriesCreated: body.inquiriesCreated as number,
      skippedExisting: body.skippedExisting as number,
    };
  });
}

export function applySuggestedFinding(caseId: string, suggestionId: string): Promise<ApiFinding> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/suggestions/findings/${encodeURIComponent(suggestionId)}/apply`, {
    method: "POST",
    headers: headers(),
  }).then((r) => unwrap<ApiFinding>(r, "finding"));
}

// ---- 研判简报（阶段三 M2 / D1·D5） ----

export interface ApiBriefOverviewSentence {
  text: string;
  chunk_id: string;
  material_id: string;
  material_name: string;
  quote: string;
  citation: ApiCitation;
}

export interface ApiBriefMaterialStats {
  total: number;
  pending: number;
  processing: number;
  done: number;
  failed: number;
  needsConfig: number;
  byModality: Record<Modality, number>;
}

export interface ApiBriefProcessingStats {
  elementCount: number;
  contradictionCount: number;
  unresolvedContradictionCount: number;
  findingCount: number;
  approvedFindingCount: number;
}

export interface ApiBriefEntity {
  id: string;
  name: string;
  type: ElementType;
  freq: number;
}

export interface ApiBriefContradiction {
  id: string;
  entity: string;
  attribute?: string;
  confidence: number;
  scope: "cross-material" | "intra-material";
  rationale: string;
  claim_a: { text: string; citation: ApiCitation };
  claim_b: { text: string; citation: ApiCitation };
  acknowledgement_status: ContradictionAcknowledgementStatus | null;
}

/** 自动研判批处理进度（阶段三 M3）：每题状态 + 整体进度，实时读 auto-inquiry.json。 */
export type ApiAutoInquiryItemStatus = "pending" | "running" | "candidate" | "done" | "failed";
export interface ApiAutoInquiryItem {
  question: string;
  status: ApiAutoInquiryItemStatus;
  inquiryId?: string;
  inquiryStatus?: "answered" | "insufficient" | "error";
  candidateCount?: number;
  error?: string;
}
export interface ApiAutoInquiryProgress {
  status: "running" | "done" | "cancelled" | "failed";
  total: number;
  completed: number;
  currentIndex: number | null;
  items: ApiAutoInquiryItem[];
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

/** 报告五节覆盖度（阶段三 M4 / D4）：固定五节，每节满足与否 + 人话明细 + 前端引导。 */
export type CoverageSectionKey = "background" | "timeline" | "contradiction" | "conclusion" | "open-items";
export interface ApiCoverageSection {
  key: CoverageSectionKey;
  title: string;
  satisfied: boolean;
  detail: string;
  action: { tab: string; label: string };
}
export interface ApiReportCoverage {
  satisfiedCount: number;
  totalSections: number;
  sections: ApiCoverageSection[];
}

export interface ApiBrief {
  caseId: string;
  generatedAt: string;
  degraded: boolean;
  fingerprint: string;
  overview: ApiBriefOverviewSentence[];
  materials: ApiBriefMaterialStats;
  processing: ApiBriefProcessingStats;
  timeline: TimelinePoint[];
  entities: ApiBriefEntity[];
  contradictions: ApiBriefContradiction[];
  openQuestions: ApiQuestionSuggestion[];
  task: ApiTaskRunSnapshot | null;
  autopilot: boolean;
  /** 自动研判批处理进度（阶段三 M3，未跑过则 null）。 */
  autoInquiry: ApiAutoInquiryProgress | null;
  /** 报告五节覆盖度（阶段三 M4，现算）。 */
  coverage: ApiReportCoverage;
}

/** 取研判简报（命中新鲜缓存则直接返回；`refresh` 强制重算）。 */
export function getBrief(caseId: string, refresh = false, signal?: AbortSignal): Promise<ApiBrief> {
  const qs = refresh ? "?refresh=1" : "";
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/brief${qs}`, { headers: headers(), signal }).then((r) => unwrap<ApiBrief>(r, "brief"));
}

export const refreshBrief = (caseId: string, signal?: AbortSignal) => getBrief(caseId, true, signal);

// ---- 后台任务（M3：大专题异步抽取/检测，进度轮询 + 取消） ----

export type JobKind = "elements" | "contradictions" | "auto-inquiry";
export type JobState = "running" | "done" | "error" | "cancelled";
export interface JobProgress { phase: string; done: number; total: number; detail?: Record<string, unknown>; }
export interface ApiJob {
  id: string;
  kind: JobKind;
  state: JobState;
  progress: JobProgress;
  result?: unknown;
  error?: string;
  startedAt: string;
}

/** 启动一次后台任务（已在跑则返回同一任务，服务端去重）。 */
export function startJob(caseId: string, kind: JobKind): Promise<ApiJob> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/jobs/${kind}/start`, { method: "POST", headers: headers() }).then((r) =>
    unwrap<ApiJob>(r, "job"),
  );
}

/** 查当前/最近一次任务状态（刷新恢复：按专题+类型取活跃任务）。无则 null。 */
export function getJobStatus(caseId: string, kind: JobKind): Promise<ApiJob | null> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/jobs/${kind}/status`, { headers: headers() }).then((r) =>
    unwrap<ApiJob | null>(r, "job"),
  );
}

/** 取消进行中的任务（在批间生效）。返回是否确有任务被取消。 */
export function cancelJob(caseId: string, kind: JobKind): Promise<boolean> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/jobs/${kind}/cancel`, { method: "POST", headers: headers() }).then((r) =>
    unwrap<boolean>(r, "cancelled"),
  );
}

// ---- 报告（M4，复核闸门） ----

export function getReport(caseId: string): Promise<ApiReport | null> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/report`, { headers: headers() }).then((r) =>
    unwrap<ApiReport | null>(r, "report"),
  );
}

/** 报告五节覆盖度（阶段三 M4，只读引导；报告尚未起草也可查）。 */
export function getReportCoverage(caseId: string): Promise<ApiReportCoverage> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/report/coverage`, { headers: headers() }).then((r) =>
    unwrap<ApiReportCoverage>(r, "coverage"),
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
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/report/export`, { method: "POST", headers: headers() }).then(async (r) => {
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown> & { message?: string; result?: unknown; export?: { filename: string; content: string; status: ReportStatus } };
    if (!r.ok || body.ok === false) {
      noteStatus(r);
      const error = new Error(body.message ?? `请求失败（HTTP ${r.status}）`) as Error & { result?: unknown };
      error.result = body.result;
      throw error;
    }
    return body.export!;
  });
}

export function generateAutoDraft(caseId: string): Promise<DraftReportInput> {
  return fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/report/auto-draft`, {
    method: "POST",
    headers: headers(),
  }).then((r) => unwrap<DraftReportInput>(r, "draft"));
}

// ---- 任务编排（Batch D） ----

export async function getCurrentTaskRun(caseId: string): Promise<ApiTaskRunSnapshot | null> {
  const res = await fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/task-runs/current`, { headers: headers() });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; snapshot?: ApiTaskRunSnapshot | null };
  if (!res.ok || body.ok === false) {
    noteStatus(res);
    throw new Error(body.message ?? `请求失败（HTTP ${res.status}）`);
  }
  return body.snapshot ?? null;
}

export async function createTaskRun(caseId: string): Promise<ApiTaskRunSnapshot> {
  const res = await fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/task-runs`, { method: "POST", headers: headers(true), body: "{}" });
  const body = (await res.json().catch(() => ({}))) as ApiTaskRunSnapshot & { ok?: boolean; message?: string };
  if (!res.ok || body.ok === false) {
    noteStatus(res);
    throw new Error(body.message ?? `请求失败（HTTP ${res.status}）`);
  }
  return { template: body.template, run: body.run, overview: body.overview };
}

export async function advanceTaskStage(caseId: string, runId: string, stageKey: string, status: TaskAdvanceStatus): Promise<ApiTaskRunSnapshot> {
  const res = await fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/task-runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageKey)}/advance`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ status }),
  });
  const body = (await res.json().catch(() => ({}))) as ApiTaskRunSnapshot & { ok?: boolean; message?: string };
  if (!res.ok || body.ok === false) {
    noteStatus(res);
    throw new Error(body.message ?? `请求失败（HTTP ${res.status}）`);
  }
  return { template: body.template, run: body.run, overview: body.overview };
}

export async function confirmTaskStage(caseId: string, runId: string, stageKey: string): Promise<ApiTaskRunSnapshot> {
  const res = await fetch(`${BASE}/cases/${encodeURIComponent(caseId)}/task-runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageKey)}/confirm`, {
    method: "POST",
    headers: headers(),
  });
  const body = (await res.json().catch(() => ({}))) as ApiTaskRunSnapshot & { ok?: boolean; message?: string };
  if (!res.ok || body.ok === false) {
    noteStatus(res);
    throw new Error(body.message ?? `请求失败（HTTP ${res.status}）`);
  }
  return { template: body.template, run: body.run, overview: body.overview };
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
