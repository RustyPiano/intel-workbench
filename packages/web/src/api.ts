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

export function listAudit(user: SessionUser): Promise<AuditEvent[]> {
  return fetch(`${BASE}/audit`, { headers: headers(user) }).then((r) => unwrap<AuditEvent[]>(r, "events"));
}

export function verifyAudit(user: SessionUser): Promise<VerifyResult> {
  return fetch(`${BASE}/audit/verify`, { headers: headers(user) }).then((r) => unwrap<VerifyResult>(r, "result"));
}
