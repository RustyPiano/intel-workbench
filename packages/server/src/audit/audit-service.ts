import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { DataPaths } from "../data/paths.js";
import type { AuditEvent, AuditResult } from "../domain/types.js";
import { sha256, shortId } from "../util/hash.js";

/**
 * 审计哈希链（工程方案 §7.2）。append-only、单写者串行、可独立校验。
 *
 * - `payload_hash = H(规范化事件内容)`，`event_hash = H(payload_hash + prev_hash)`。
 * - 全局 `audit/audit.jsonl` 为权威；若事件关联专题，再镜像一行到
 *   `cases/<id>/audit.log`（本地筛选副本）。
 * - 命名与 Citation 的 `content_hash` 刻意区分（§7.2）。
 */

const GENESIS = "0".repeat(64);

/** 稳定序列化：键名递归排序、跳过 undefined，保证 hash 可复算。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** 进入 hash 的事件主体（不含 *_hash 派生字段）。 */
function payloadOf(e: Pick<AuditEvent, "id" | "ts" | "user" | "action" | "object" | "result" | "detail">) {
  return { id: e.id, ts: e.ts, user: e.user, action: e.action, object: e.object, result: e.result, detail: e.detail };
}

export interface AppendInput {
  user: string;
  action: string;
  object: string;
  result?: AuditResult;
  detail?: Record<string, unknown>;
  /** 关联专题：额外镜像一行到 `cases/<id>/audit.log`。 */
  caseId?: string;
}

export interface VerifyResult {
  ok: boolean;
  count: number;
  /** 断链事件下标（从 0 起），仅 ok=false 时有。 */
  brokenAt?: number;
  reason?: string;
}

export interface ReconcileResult {
  ok: boolean;
  /** 有产物（manifest）但无 `case.create` 审计事件的孤儿专题（§5.4）。 */
  orphanCases: string[];
}

export class AuditService {
  /** 单写者串行队列（复用 file-mutation-queue 思路，§7.2）。 */
  private tail: Promise<unknown> = Promise.resolve();
  /** 末位 event_hash 缓存，避免每次 append 重扫全文件。 */
  private lastHash: string | null = null;

  constructor(private readonly paths: DataPaths) {}

  async append(input: AppendInput): Promise<AuditEvent> {
    const run = this.tail.then(() => this.appendNow(input));
    // 保持链不被一次失败打断；调用方仍能从返回的 promise 看到错误。
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async appendNow(input: AppendInput): Promise<AuditEvent> {
    const prevHash = this.lastHash ?? (await this.readLastHash());
    const base = payloadOf({
      id: shortId("e-"),
      ts: new Date().toISOString(),
      user: input.user,
      action: input.action,
      object: input.object,
      result: input.result ?? "ok",
      detail: input.detail,
    });
    const payload_hash = sha256(stableStringify(base));
    const event_hash = sha256(payload_hash + prevHash);
    const event: AuditEvent = { ...base, payload_hash, prev_hash: prevHash, event_hash };

    const line = `${JSON.stringify(event)}\n`;
    await mkdir(path.dirname(this.paths.auditFile), { recursive: true });
    await appendFile(this.paths.auditFile, line, "utf8");
    if (input.caseId) {
      const caseLog = this.paths.caseAuditLog(input.caseId);
      await mkdir(path.dirname(caseLog), { recursive: true });
      await appendFile(caseLog, line, "utf8");
    }
    this.lastHash = event_hash;
    return event;
  }

  private async readLastHash(): Promise<string> {
    const events = await this.readAll();
    return events.length ? events[events.length - 1].event_hash : GENESIS;
  }

  async readAll(): Promise<AuditEvent[]> {
    return this.readLog(this.paths.auditFile);
  }

  /** 读某专题的审计镜像 `cases/<id>/audit.log`（§7.2 本地筛选副本）；无则空。 */
  async readCaseEvents(caseId: string): Promise<AuditEvent[]> {
    return this.readLog(this.paths.caseAuditLog(caseId));
  }

  private async readLog(file: string): Promise<AuditEvent[]> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    return raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as AuditEvent);
  }

  /** 重算全链，定位首个断点（工程方案 §7.2，`GET /api/audit/verify`）。 */
  async verify(): Promise<VerifyResult> {
    const events = await this.readAll();
    let prev = GENESIS;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const payload = sha256(stableStringify(payloadOf(e)));
      if (payload !== e.payload_hash) {
        return { ok: false, count: events.length, brokenAt: i, reason: "事件内容被篡改（payload_hash 不匹配）" };
      }
      if (e.prev_hash !== prev) {
        return { ok: false, count: events.length, brokenAt: i, reason: "链接断裂（prev_hash 不匹配）" };
      }
      if (sha256(payload + prev) !== e.event_hash) {
        return { ok: false, count: events.length, brokenAt: i, reason: "event_hash 不匹配" };
      }
      prev = e.event_hash;
    }
    return { ok: true, count: events.length };
  }

  /** 对账：列出有产物却缺 `case.create` 审计的孤儿专题（§5.4）。 */
  async reconcile(caseIds: string[]): Promise<ReconcileResult> {
    const events = await this.readAll();
    const created = new Set(
      events
        .filter((e) => e.action === "case.create" && e.result === "ok")
        .map((e) => String(e.detail?.caseId ?? "")),
    );
    const orphanCases = caseIds.filter((id) => !created.has(id));
    return { ok: orphanCases.length === 0, orphanCases };
  }
}
