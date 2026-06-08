import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import { AppError } from "../domain/identity.js";
import {
  CLEARANCE_LABELS,
  type BulletinSpec,
  type CaseManifest,
  type Identity,
  type ReportRecord,
} from "../domain/types.js";

const execFileAsync = promisify(execFile);

/**
 * 报告草稿生成与复核闸门（工程方案 §7.4 / §3）。
 *
 * 草稿生成复用 intel-bulletin 的 `render_report.py`（写 spec → 调脚本渲染 .md）。
 * 状态机：draft → in_review → approved → exported；export 仅在 approved/exported
 * 放行，其余状态拒绝并记审计（红线 §7.4）。复核人记录，一期不强制 ≠ 起草人。
 */

export interface DraftInput {
  title?: string;
  classification?: string;
  recipient?: string;
  summary?: string;
  sections?: { heading?: string; body?: string }[];
  /** 简化输入：无 sections 时把 body 包成单节"正文"。 */
  body?: string;
  conclusion?: string;
  issuer?: string;
  date?: string;
}

export interface ExportResult {
  filename: string;
  content: string;
  status: ReportRecord["status"];
}

/** intel-bulletin 渲染脚本路径（可由 WORKBENCH_BULLETIN_SCRIPT 覆盖）。 */
function bulletinScriptPath(): string {
  if (process.env.WORKBENCH_BULLETIN_SCRIPT) return process.env.WORKBENCH_BULLETIN_SCRIPT;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/server/{src,dist}/report -> repo root
  return path.resolve(here, "..", "..", "..", "..", ".agents", "skills", "intel-bulletin", "scripts", "render_report.py");
}

export class ReportService {
  constructor(
    private readonly paths: DataPaths,
    private readonly audit: AuditService,
    private readonly cases: CaseService,
  ) {}

  async draft(actor: Identity, caseId: string, input: DraftInput): Promise<ReportRecord> {
    const manifest = await this.cases.get(actor, caseId);
    const spec = this.buildSpec(input, manifest);

    const prev = await this.read(caseId);
    const now = new Date().toISOString();
    // 任何编辑都回到 draft（既有复核失效，需重新走闸门）。
    const record: ReportRecord = {
      status: "draft",
      spec,
      drafted_by: actor.id,
      drafted_at: now,
      rendered: false,
    };
    await this.writeSpec(caseId, spec);
    record.rendered = await this.render(caseId);
    await this.write(caseId, record);
    await this.audit.append({
      user: actor.id,
      action: "report.draft",
      object: `report:${caseId}`,
      caseId,
      detail: { caseId, rendered: record.rendered, redraftedFrom: prev?.status },
    });
    return record;
  }

  async get(actor: Identity, caseId: string): Promise<ReportRecord | null> {
    await this.cases.get(actor, caseId);
    return this.read(caseId);
  }

  async submit(actor: Identity, caseId: string): Promise<ReportRecord> {
    const record = await this.require(actor, caseId);
    if (record.status !== "draft") throw new AppError(409, `仅草稿态可提交复核（当前：${record.status}）`);
    record.status = "in_review";
    record.submitted_by = actor.id;
    record.submitted_at = new Date().toISOString();
    await this.write(caseId, record);
    await this.audit.append({ user: actor.id, action: "report.submit", object: `report:${caseId}`, caseId, detail: { caseId } });
    return record;
  }

  async approve(actor: Identity, caseId: string): Promise<ReportRecord> {
    if (actor.role !== "security" && actor.role !== "admin") {
      throw new AppError(403, "仅保密员或管理员可复核核准");
    }
    const record = await this.require(actor, caseId);
    if (record.status !== "in_review") throw new AppError(409, `仅待复核态可核准（当前：${record.status}）`);
    record.status = "approved";
    record.reviewed_by = actor.id;
    record.approved_at = new Date().toISOString();
    await this.write(caseId, record);
    await this.audit.append({
      user: actor.id,
      action: "report.approve",
      object: `report:${caseId}`,
      caseId,
      // 一期不强制复核人 ≠ 起草人，但记录是否同人（§7.4）。
      detail: { caseId, samePerson: record.reviewed_by === record.drafted_by },
    });
    return record;
  }

  async export(actor: Identity, caseId: string): Promise<ExportResult> {
    const record = await this.require(actor, caseId);
    // 闸门：未复核态一律拒绝导出（红线 §7.4）。
    if (record.status !== "approved" && record.status !== "exported") {
      await this.audit.append({
        user: actor.id,
        action: "report.export",
        object: `report:${caseId}`,
        result: "deny",
        caseId,
        detail: { caseId, status: record.status, reason: "未复核，禁止导出" },
      });
      throw new AppError(409, `报告未复核，禁止导出（当前：${record.status}）`);
    }
    const content = await readFile(this.markdownPath(caseId), "utf8");
    record.status = "exported";
    record.exported_by = actor.id;
    record.exported_at = new Date().toISOString();
    await this.write(caseId, record);
    await this.audit.append({ user: actor.id, action: "report.export", object: `report:${caseId}`, caseId, detail: { caseId } });
    return { filename: `${caseId}-bulletin.md`, content, status: record.status };
  }

  private buildSpec(input: DraftInput, manifest: CaseManifest): BulletinSpec {
    const title = input.title?.trim();
    if (!title) throw new AppError(400, "报告标题为必填项");
    const sections = (input.sections ?? [])
      .map((s) => ({ heading: (s.heading ?? "").trim(), body: (s.body ?? "").trim() }))
      .filter((s) => s.heading || s.body);
    if (sections.length === 0 && input.body?.trim()) {
      sections.push({ heading: "正文", body: input.body.trim() });
    }
    return {
      title,
      classification: input.classification?.trim() || CLEARANCE_LABELS[manifest.clearance],
      recipient: input.recipient?.trim() || undefined,
      summary: input.summary?.trim() || undefined,
      sections,
      conclusion: input.conclusion?.trim() || undefined,
      issuer: input.issuer?.trim() || undefined,
      date: input.date?.trim() || new Date().toISOString().slice(0, 10),
    };
  }

  /** 调 render_report.py 渲染 .md（读已落盘的 spec）；失败不阻塞草稿。 */
  private async render(caseId: string): Promise<boolean> {
    const outBase = path.join(this.reportDir(caseId), "bulletin");
    try {
      await execFileAsync("python3", [bulletinScriptPath(), this.specPath(caseId), outBase], { timeout: 20_000 });
      return true;
    } catch {
      return false;
    }
  }

  private reportDir(caseId: string): string {
    return path.join(this.paths.caseDir(caseId), "report");
  }
  private recordPath(caseId: string): string {
    return path.join(this.reportDir(caseId), "report.json");
  }
  private specPath(caseId: string): string {
    return path.join(this.reportDir(caseId), "bulletin.spec.json");
  }
  private markdownPath(caseId: string): string {
    return path.join(this.reportDir(caseId), "bulletin.md");
  }

  private async read(caseId: string): Promise<ReportRecord | null> {
    try {
      return JSON.parse(await readFile(this.recordPath(caseId), "utf8")) as ReportRecord;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  private async require(actor: Identity, caseId: string): Promise<ReportRecord> {
    await this.cases.get(actor, caseId);
    const record = await this.read(caseId);
    if (!record) throw new AppError(404, "报告尚未创建（请先生成草稿）");
    return record;
  }

  private async write(caseId: string, record: ReportRecord): Promise<void> {
    await mkdir(this.reportDir(caseId), { recursive: true });
    await writeFile(this.recordPath(caseId), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  private async writeSpec(caseId: string, spec: BulletinSpec): Promise<void> {
    await mkdir(this.reportDir(caseId), { recursive: true });
    await writeFile(this.specPath(caseId), `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  }
}
