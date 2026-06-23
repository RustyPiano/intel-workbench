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
  type BulletinSection,
  type BulletinSpec,
  type CaseManifest,
  type Chunk,
  type Citation,
  type Finding,
  type Identity,
  type ReportCoverageStatus,
  type ReportRecord,
} from "../domain/types.js";
import { readContradictionAcknowledgements, readFindings } from "../finding/finding-store.js";
import { sha256 } from "../util/hash.js";

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
  sections?: {
    heading?: string;
    body?: string;
    finding_ids?: string[];
    citation_ids?: string[];
    coverage_status?: ReportCoverageStatus;
    key_conclusion?: boolean;
  }[];
  finding_ids?: string[];
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

export function citationId(citation: Citation): string {
  return `${citation.material_id}:${citation.content_hash}:${citation.quote_hash ?? ""}`;
}

interface CitationPoolEntry {
  citation: Citation;
  finding: Finding;
}

interface CitationValidation {
  validChunk: boolean;
  validSpan: boolean;
  missingSpan: boolean;
}

class ExportGateError extends AppError {
  readonly result: { reasons: string[] };

  constructor(reasons: string[]) {
    super(409, "报告证据覆盖闸未通过，禁止导出");
    this.result = { reasons };
  }
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
    const spec = await this.buildSpec(input, manifest, caseId);

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
    const gateReasons = await this.evaluateExportGate(caseId, record);
    if (gateReasons.length > 0) {
      for (const reason of gateReasons) {
        await this.audit.append({
          user: actor.id,
          action: "report.export.gate",
          object: `report:${caseId}`,
          result: "deny",
          caseId,
          detail: { caseId, reason },
        });
      }
      await this.audit.append({
        user: actor.id,
        action: "report.export",
        object: `report:${caseId}`,
        result: "deny",
        caseId,
        detail: { caseId, status: record.status, reasons: gateReasons },
      });
      throw new ExportGateError(gateReasons);
    }
    await this.audit.append({
      user: actor.id,
      action: "report.export.gate",
      object: `report:${caseId}`,
      caseId,
      detail: { caseId, allowed: true },
    });
    const content = await readFile(this.markdownPath(caseId), "utf8");
    if (record.status === "approved") {
      record.status = "exported";
      record.exported_by = actor.id;
      record.exported_at = new Date().toISOString();
      await this.write(caseId, record);
    }
    await this.audit.append({ user: actor.id, action: "report.export", object: `report:${caseId}`, caseId, detail: { caseId } });
    return { filename: `${caseId}-bulletin.md`, content, status: record.status };
  }

  private async buildSpec(input: DraftInput, manifest: CaseManifest, caseId: string): Promise<BulletinSpec> {
    const title = input.title?.trim();
    if (!title) throw new AppError(400, "报告标题为必填项");
    const approvedFindings = (await readFindings(this.paths, caseId)).filter((finding) => finding.review_status === "approved");
    const sections = input.finding_ids !== undefined
      ? this.sectionsFromFindings(this.selectApprovedFindings(approvedFindings, input.finding_ids))
      : (input.sections ?? []).map((s) => this.normalizeSection(s)).filter((s) => s.heading || s.body || s.finding_ids.length > 0 || s.citation_ids.length > 0);
    if (sections.length === 0 && input.body?.trim()) {
      sections.push(this.normalizeSection({ heading: "正文", body: input.body.trim() }));
    }
    if (sections.length === 0 && !input.body?.trim()) {
      sections.push(...this.sectionsFromFindings(approvedFindings));
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

  private normalizeSection(input: NonNullable<DraftInput["sections"]>[number]): BulletinSection {
    const findingIds = cleanIds(input.finding_ids);
    const citationIds = cleanIds(input.citation_ids);
    return {
      heading: (input.heading ?? "").trim(),
      body: (input.body ?? "").trim(),
      finding_ids: findingIds,
      citation_ids: citationIds,
      coverage_status: input.coverage_status ?? (citationIds.length > 0 ? "covered" : "uncovered"),
      ...(input.key_conclusion !== undefined ? { key_conclusion: input.key_conclusion } : {}),
    };
  }

  private selectApprovedFindings(approvedFindings: Finding[], requestedIds: string[]): Finding[] {
    const byId = new Map(approvedFindings.map((finding) => [finding.id, finding]));
    const selected = cleanIds(requestedIds).map((id) => byId.get(id));
    if (selected.some((finding) => !finding)) throw new AppError(400, "报告只能引用已审核 Finding");
    return selected as Finding[];
  }

  private sectionsFromFindings(findings: Finding[]): BulletinSection[] {
    return findings.map((finding, index) => {
      const citationIds = finding.supporting_citations.map(citationId);
      return {
        heading: `研判结论${index + 1}`,
        body: finding.conclusion,
        finding_ids: [finding.id],
        citation_ids: citationIds,
        coverage_status: citationIds.length > 0 ? "covered" : "uncovered",
        key_conclusion: true,
      };
    });
  }

  private async evaluateExportGate(caseId: string, record: ReportRecord): Promise<string[]> {
    const reasons = new Set<string>();
    const findings = await readFindings(this.paths, caseId);
    const findingById = new Map(findings.map((finding) => [finding.id, finding]));
    const approvedFindings = findings.filter((finding) => finding.review_status === "approved");
    const citationById = new Map<string, CitationPoolEntry>();
    for (const finding of approvedFindings) {
      for (const citation of finding.supporting_citations) {
        citationById.set(citationId(citation), { citation, finding });
      }
    }
    const chunks = await this.loadCaseChunks(caseId);
    const reportFindings = new Map<string, Finding>();

    for (const section of record.spec.sections ?? []) {
      const findingIds = cleanIds(section.finding_ids);
      const citationIds = cleanIds(section.citation_ids);
      const sectionFindings: Finding[] = [];

      for (const findingId of findingIds) {
        const finding = findingById.get(findingId);
        if (!finding) {
          reasons.add("finding:missing");
        } else if (finding.review_status === "rejected") {
          reasons.add("finding:rejected");
        } else if (finding.review_status !== "approved") {
          reasons.add("finding:not-approved");
        } else {
          sectionFindings.push(finding);
          reportFindings.set(finding.id, finding);
        }
      }
      let hasValidSpan = false;
      for (const id of citationIds) {
        const entry = citationById.get(id);
        if (!entry || (findingIds.length > 0 && !findingIds.includes(entry.finding.id))) {
          reasons.add("citation:invalid");
          continue;
        }
        const validation = this.validateCitation(entry.citation, chunks);
        if (!validation.validChunk || (!validation.validSpan && !validation.missingSpan)) {
          reasons.add("citation:invalid");
        } else if (validation.validSpan) {
          hasValidSpan = true;
        }
      }
      for (const finding of sectionFindings) {
        const validation = this.validateFindingCitations(finding, chunks, reasons);
        if (validation.hasValidSpan) hasValidSpan = true;
      }

      const heading = section.heading.trim();
      const body = section.body.trim();
      if (heading && sectionFindings.length === 0) {
        reasons.add("coverage:uncited-fact");
      }
      if (body) {
        if (sectionFindings.length === 0) {
          reasons.add("coverage:uncited-fact");
        } else if (!this.bodySupportedByFindings(body, sectionFindings)) {
          reasons.add("coverage:body-unsupported");
        }
      }
      if ((heading || body || section.key_conclusion) && sectionFindings.length > 0 && !hasValidSpan) {
        reasons.add("citation:no-span");
      }
    }
    this.validateStandaloneProse(record.spec.summary, [...reportFindings.values()], chunks, reasons);
    this.validateStandaloneProse(record.spec.conclusion, [...reportFindings.values()], chunks, reasons);
    if (await this.hasHighSeverityContradiction(caseId)) {
      reasons.add("contradiction:high-severity-unresolved");
    }
    return [...reasons];
  }

  private validateCitation(citation: Citation, chunks: Chunk[]): CitationValidation {
    const candidates = chunks.filter(
      (chunk) => chunk.material_id === citation.material_id
        && chunk.content_hash === citation.content_hash
        && sha256(chunk.text) === chunk.content_hash,
    );
    if (candidates.length === 0) return { validChunk: false, validSpan: false, missingSpan: false };
    if (!citation.quote || !citation.quote_hash) {
      return { validChunk: true, validSpan: false, missingSpan: true };
    }
    if (sha256(citation.quote) !== citation.quote_hash) {
      return { validChunk: true, validSpan: false, missingSpan: false };
    }
    const validSpan = candidates.some((chunk) => chunk.text.includes(citation.quote!));
    return { validChunk: true, validSpan, missingSpan: false };
  }

  private validateFindingCitations(finding: Finding, chunks: Chunk[], reasons: Set<string>): { hasValidSpan: boolean } {
    let hasValidSpan = false;
    for (const citation of finding.supporting_citations) {
      const validation = this.validateCitation(citation, chunks);
      if (!validation.validChunk || (!validation.validSpan && !validation.missingSpan)) {
        reasons.add("citation:invalid");
      } else if (validation.validSpan) {
        hasValidSpan = true;
      }
    }
    return { hasValidSpan };
  }

  private validateStandaloneProse(text: string | undefined, findings: Finding[], chunks: Chunk[], reasons: Set<string>): void {
    const body = text?.trim();
    if (!body) return;
    if (findings.length === 0 || !this.bodySupportedByFindings(body, findings)) {
      reasons.add("coverage:uncited-fact");
      return;
    }
    let hasValidSpan = false;
    for (const finding of findings) {
      const validation = this.validateFindingCitations(finding, chunks, reasons);
      if (validation.hasValidSpan) hasValidSpan = true;
    }
    if (!hasValidSpan) reasons.add("citation:no-span");
  }

  private bodySupportedByFindings(body: string, findings: Finding[]): boolean {
    const normalizedBody = normalizeProse(body);
    const conclusions = findings.map((finding) => normalizeProse(finding.conclusion)).filter(Boolean);
    if (conclusions.includes(normalizedBody)) return true;
    return normalizedBody === conclusions.join("\n") || normalizedBody === conclusions.join("\n\n");
  }

  private async hasHighSeverityContradiction(caseId: string): Promise<boolean> {
    const result = await this.readJson<{ contradictions?: Array<{ id?: string; confidence?: number }> }>(
      path.join(this.paths.caseDir(caseId), "contradictions.result.json"),
    );
    const contradictions = Array.isArray(result?.contradictions)
      ? result.contradictions
      : await this.readJson<Array<{ id?: string; confidence?: number }>>(path.join(this.paths.caseDir(caseId), "contradictions.json"));
    if (!Array.isArray(contradictions)) return false;
    const acknowledgements = await readContradictionAcknowledgements(this.paths, caseId);
    const statusByContradiction = new Map(acknowledgements.map((ack) => [ack.contradiction_id, ack.status]));
    return contradictions.some((contradiction) => {
      if ((contradiction.confidence ?? 0) < 0.75) return false;
      const status = statusByContradiction.get(contradiction.id ?? "") ?? "open";
      return status === "open";
    });
  }

  private async loadCaseChunks(caseId: string): Promise<Chunk[]> {
    const manifest = await this.cases.loadManifest(caseId);
    if (!manifest) return [];
    const chunks: Chunk[] = [];
    for (const material of manifest.materials) {
      if (material.status !== "done") continue;
      try {
        const raw = await readFile(path.join(this.paths.caseDir(caseId), "processed", `${material.id}.chunks.jsonl`), "utf8");
        chunks.push(...raw.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Chunk));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    return chunks;
  }

  private async readJson<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
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

function cleanIds(ids: unknown): string[] {
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim()) : [];
}

function normalizeProse(value: string): string {
  return value
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.、]|[一二三四五六七八九十]+[、.])\s*/, "").trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n");
}
