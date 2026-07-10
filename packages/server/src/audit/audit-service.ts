import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { DataPaths } from "../data/paths.js";
import type { AuditEvent, AuditResult } from "../domain/types.js";
import { sha256, shortId } from "../util/hash.js";

/**
 * 审计哈希链（工程方案 §7.2）。append-only、单写者串行、可独立校验。
 *
 * - `payload_hash = H(规范化事件内容)`，`event_hash = H(payload_hash + prev_hash)`。
 * - 全局 `audit/audit.jsonl` 是**唯一权威链**；专题视图是它的按 caseId 投影
 *   （见 `readCaseEvents`），不再落 `cases/<id>/audit.log` 镜像，杜绝双写与链外副本。
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
  /**
   * 关联专题标记。事件仍只写全局权威链；此字段供 `readCaseEvents` 投影时识别归属
   * （落在 `detail.caseId` 或 `object: case:<id>` 上）。不再触发任何镜像写。
   */
  caseId?: string;
}

export interface VerifyResult {
  ok: boolean;
  count: number;
  /** 断链所在行号（从 1 起），仅 ok=false 时有。 */
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
    // 全局日志是唯一权威链：追加成功即推进链头。
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

  /**
   * 某专题的审计视图：全局权威链按 caseId 投影（§7.2，取代旧的 `cases/<id>/audit.log` 镜像）。
   * 归属判定 = 事件 `detail.caseId` 命中，或 `object` 为 `case:<id>`（专题级动作，如
   * `case.create`/`review.mark`/`contradiction.detect` 等不带 `detail.caseId` 者）。
   */
  async readCaseEvents(caseId: string): Promise<AuditEvent[]> {
    const target = `case:${caseId}`;
    return (await this.readAll()).filter((e) => e.detail?.caseId === caseId || e.object === target);
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

  /**
   * 重算全链，逐行解析定位首个断点（工程方案 §7.2，`GET /api/audit/verify`）。
   * 畸形 JSON 行不再抛异常：返回带精确 1-based 行号的失败结果，避免调用方直落 500。
   * 文件不存在/空链视为合法（全新数据根）。
   */
  async verify(): Promise<VerifyResult> {
    let raw: string;
    try {
      raw = await readFile(this.paths.auditFile, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, count: 0 };
      throw e;
    }
    const lines = raw.split("\n");
    let prev = GENESIS;
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length === 0) continue; // 尾部换行等空行不入链
      const brokenAt = i + 1; // 1-based 行号
      let e: AuditEvent;
      try {
        e = JSON.parse(line) as AuditEvent;
      } catch {
        return { ok: false, count, brokenAt, reason: "审计行不是合法 JSON（无法解析）" };
      }
      const payload = sha256(stableStringify(payloadOf(e)));
      if (payload !== e.payload_hash) {
        return { ok: false, count, brokenAt, reason: "事件内容被篡改（payload_hash 不匹配）" };
      }
      if (e.prev_hash !== prev) {
        return { ok: false, count, brokenAt, reason: "链接断裂（prev_hash 不匹配）" };
      }
      if (sha256(payload + prev) !== e.event_hash) {
        return { ok: false, count, brokenAt, reason: "event_hash 不匹配" };
      }
      prev = e.event_hash;
      count++;
    }
    return { ok: true, count };
  }

  /**
   * 启动前完整校验一次哈希链（工程方案 §7.2）。断链/畸形行 → 抛出带精确行号与恢复提示
   * 的错误，由入口拒绝启动。空链或文件不存在视为合法（全新数据根）。
   */
  async initialize(): Promise<void> {
    const result = await this.verify();
    if (!result.ok) {
      throw new Error(
        `审计哈希链校验未通过：${this.paths.auditFile} 第 ${result.brokenAt} 行 —— ${result.reason}。` +
          `请人工修复该行后重启；演示数据根可执行 pnpm demo:reset 从零重建，自定数据根请先迁走数据再清理。`,
      );
    }
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
