import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import type { CaseManifest, Contradiction, ContradictionAcknowledgement, Finding, Identity, ReportRecord, ReportStatus } from "../domain/types.js";
import { readContradictionAcknowledgements, findingsFilePath } from "../finding/finding-store.js";
import { computeCoverage } from "../report/coverage.js";
import { readWorkflowState, type WorkflowState } from "../workflow/types.js";

/**
 * 专题聚合状态端点（破坏性收敛 R2 · 批次 D）。GET /cases/:id/status。
 *
 * 每一节独立按落盘事实三态呈现：缺产物 = not_started；文件损坏/读取失败 = error + 准确
 * message；有产物 = ready + 数据。绝不把错误转成零值（零 ≠ 未开始 ≠ 读失败）。素材统计从
 * manifest 派生（专题存在即 ready）；workflow 用冻结的 readWorkflowState；报告覆盖率复用
 * coverage。访问闸门经 cases.get（沿用现有专题读权限，不可读专题在此抛 403/404）。
 */

/** 与 report/coverage.ts 及导出闸同口径 0.75。ponytail: 字面量，不跨文件耦合。 */
const HIGH_CONFIDENCE = 0.75;

export type StatusSection<T> = ({ state: "ready" } & T) | { state: "not_started" } | { state: "error"; message: string };

export interface CaseStatusPayload {
  materials: StatusSection<{ total: number; processed: number; failed: number }>;
  workflow: StatusSection<{ data: WorkflowState }>;
  contradictions: StatusSection<{ total: number; openHighConfidence: number }>;
  findings: StatusSection<{ total: number; approved: number; pending: number }>;
  report: StatusSection<{ status: ReportStatus; coverage: { covered: number; total: number } }>;
  audit: StatusSection<{ count: number }>;
}

type JsonRead<T> = { kind: "ready"; value: T } | { kind: "not_started" } | { kind: "error"; message: string };

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 三态读 JSON：ENOENT → not_started；解析/读取失败 → error；成功 → ready + value。 */
async function readJson<T>(file: string): Promise<JsonRead<T>> {
  try {
    return { kind: "ready", value: JSON.parse(await readFile(file, "utf8")) as T };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "not_started" };
    return { kind: "error", message: errMessage(e) };
  }
}

export class StatusService {
  constructor(
    private readonly paths: DataPaths,
    private readonly cases: Pick<CaseService, "get">,
    private readonly audit: Pick<AuditService, "readCaseEvents">,
  ) {}

  async getStatus(actor: Identity, caseId: string): Promise<CaseStatusPayload> {
    const manifest = await this.cases.get(actor, caseId);
    const [workflow, contradictions, findings, report, audit] = await Promise.all([
      this.workflowSection(caseId),
      this.contradictionsSection(caseId),
      this.findingsSection(caseId),
      this.reportSection(caseId, manifest),
      this.auditSection(caseId),
    ]);
    return { materials: this.materialsSection(manifest), workflow, contradictions, findings, report, audit };
  }

  /** 素材统计从 manifest 派生（专题可读 = manifest 已在，故恒 ready）。 */
  private materialsSection(manifest: CaseManifest): CaseStatusPayload["materials"] {
    const materials = manifest.materials;
    return {
      state: "ready",
      total: materials.length,
      processed: materials.filter((m) => m.status === "done").length,
      failed: materials.filter((m) => m.status === "failed").length,
    };
  }

  private async workflowSection(caseId: string): Promise<CaseStatusPayload["workflow"]> {
    try {
      const data = await readWorkflowState(this.paths.workflowFile(caseId));
      return data === null ? { state: "not_started" } : { state: "ready", data };
    } catch (e) {
      return { state: "error", message: errMessage(e) };
    }
  }

  private async contradictionsSection(caseId: string): Promise<CaseStatusPayload["contradictions"]> {
    const read = await readJson<{ contradictions?: Contradiction[] }>(path.join(this.paths.caseDir(caseId), "contradictions.result.json"));
    if (read.kind !== "ready") return read.kind === "not_started" ? { state: "not_started" } : { state: "error", message: read.message };
    let acks: ContradictionAcknowledgement[];
    try {
      acks = await readContradictionAcknowledgements(this.paths, caseId);
    } catch (e) {
      return { state: "error", message: errMessage(e) };
    }
    const statusById = new Map(acks.map((a) => [a.contradiction_id, a.status]));
    const list = Array.isArray(read.value.contradictions) ? read.value.contradictions : [];
    const openHighConfidence = list.filter((c) => (c.confidence ?? 0) >= HIGH_CONFIDENCE && (statusById.get(c.id) ?? "open") === "open").length;
    return { state: "ready", total: list.length, openHighConfidence };
  }

  private async findingsSection(caseId: string): Promise<CaseStatusPayload["findings"]> {
    const read = await readJson<Finding[]>(findingsFilePath(this.paths, caseId));
    if (read.kind !== "ready") return read.kind === "not_started" ? { state: "not_started" } : { state: "error", message: read.message };
    const list = Array.isArray(read.value) ? read.value : [];
    return {
      state: "ready",
      total: list.length,
      approved: list.filter((f) => f.review_status === "approved").length,
      pending: list.filter((f) => f.review_status === "draft").length,
    };
  }

  private async reportSection(caseId: string, manifest: CaseManifest): Promise<CaseStatusPayload["report"]> {
    const read = await readJson<ReportRecord>(path.join(this.paths.caseDir(caseId), "report", "report.json"));
    if (read.kind !== "ready") return read.kind === "not_started" ? { state: "not_started" } : { state: "error", message: read.message };
    try {
      const coverage = await computeCoverage(this.paths, caseId, manifest);
      return { state: "ready", status: read.value.status, coverage: { covered: coverage.satisfiedCount, total: coverage.totalSections } };
    } catch (e) {
      return { state: "error", message: errMessage(e) };
    }
  }

  private async auditSection(caseId: string): Promise<CaseStatusPayload["audit"]> {
    try {
      const events = await this.audit.readCaseEvents(caseId);
      return { state: "ready", count: events.length };
    } catch (e) {
      return { state: "error", message: errMessage(e) };
    }
  }
}
