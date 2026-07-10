import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { FileMutationQueue } from "mini-agent";

import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import { AppError } from "../domain/identity.js";
import {
  CLEARANCE_LABELS,
  CLEARANCES,
  clearanceRank,
  type BulletinSection,
  type BulletinSpec,
  type CaseManifest,
  type Chunk,
  type Citation,
  type Clearance,
  type Finding,
  type Identity,
  type ReportCoverageStatus,
  type ReportRecord,
} from "../domain/types.js";
import { readContradictionAcknowledgements, readFindings } from "../finding/finding-store.js";
import { validateCitationIntegrity, type CitationIntegrity } from "../inquiry/citation.js";
import { writeFileAtomic } from "../util/atomic.js";
import { sha256, shortId } from "../util/hash.js";
import { computeCoverage, type ReportCoverage } from "./coverage.js";

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
  // locator 始终入键：content_hash=sha256(text)，故同素材内文本完全相同但 locator 不同的
  // chunk（同一句出现在不同时间码/段落/页）必须区分，否则两条不同来源的引用会撞同一 ID。
  return [
    citation.material_id,
    citation.content_hash,
    citation.quote_hash ?? "",
    citation.quote_char_start ?? "",
    citation.quote_char_end ?? "",
    JSON.stringify(citation.locator),
  ].join(":");
}

interface CitationPoolEntry {
  citation: Citation;
  findingIds: Set<string>;
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
  private readonly queue = new FileMutationQueue();

  constructor(
    private readonly paths: DataPaths,
    private readonly audit: AuditService,
    private readonly cases: CaseService,
  ) {}

  async draft(actor: Identity, caseId: string, input: DraftInput): Promise<ReportRecord> {
    const manifest = await this.cases.get(actor, caseId);
    return this.queue.runExclusive(this.recordPath(caseId), async () => {
      const spec = await this.buildSpec(input, manifest, caseId);
      const prev = await this.read(caseId);
      const revision = (prev?.revision ?? 0) + 1;
      const now = new Date().toISOString();
      await this.writeSpec(caseId, spec);
      const markdown = await this.render(caseId);
      if (markdown === null) await rm(this.markdownPath(caseId), { force: true });
      else await writeFileAtomic(this.markdownPath(caseId), markdown);
      // 任何编辑都构造全新 draft record，不复制任何提交/审批痕迹。
      const record: ReportRecord = {
        status: "draft",
        spec,
        revision,
        ...(markdown === null ? {} : { contentHash: this.contentHash(spec, markdown) }),
        drafted_by: actor.id,
        drafted_at: now,
        rendered: markdown !== null,
      };
      await this.write(caseId, record);
      await this.audit.append({
        user: actor.id,
        action: "report.draft",
        object: `report:${caseId}`,
        caseId,
        detail: { caseId, revision, contentHash: record.contentHash, rendered: record.rendered, redraftedFrom: prev?.status },
      });
      return record;
    });
  }

  async get(actor: Identity, caseId: string): Promise<ReportRecord | null> {
    await this.cases.get(actor, caseId);
    return this.read(caseId);
  }

  /**
   * 报告五节覆盖度（阶段三 M4 / 计划 D4）。只做展示与引导，独立于 evaluateExportGate 的导出硬门禁。
   * 密级由 cases.get 收口；覆盖度就现有落盘产物现算，报告尚未起草也可返回（各节不依赖报告存在）。
   */
  async getCoverage(actor: Identity, caseId: string): Promise<ReportCoverage> {
    const manifest = await this.cases.get(actor, caseId);
    return computeCoverage(this.paths, caseId, manifest);
  }

  async submit(actor: Identity, caseId: string): Promise<ReportRecord> {
    return this.queue.runExclusive(this.recordPath(caseId), async () => {
      const record = await this.require(actor, caseId);
      if (record.status !== "draft") throw new AppError(409, `仅草稿态可提交复核（当前：${record.status}）`);
      await this.requireCurrentClassification(caseId, record);
      await this.requireCurrentContent(caseId, record, true);
      await this.requireCompleteContradictions(caseId);
      record.status = "in_review";
      record.submittedRevision = record.revision;
      record.submittedContentHash = record.contentHash;
      record.submitted_by = actor.id;
      record.submitted_at = new Date().toISOString();
      await this.write(caseId, record);
      await this.audit.append({ user: actor.id, action: "report.submit", object: `report:${caseId}`, caseId, detail: { caseId, revision: record.revision, contentHash: record.contentHash } });
      return record;
    });
  }

  async approve(actor: Identity, caseId: string): Promise<ReportRecord> {
    if (actor.role !== "security" && actor.role !== "admin") {
      await this.audit.append({
        user: actor.id,
        action: "report.approve",
        object: `report:${caseId}`,
        result: "deny",
        caseId,
        detail: { caseId, reason: "role" },
      });
      throw new AppError(403, "仅保密员或管理员可复核核准");
    }
    return this.queue.runExclusive(this.recordPath(caseId), async () => {
      const record = await this.require(actor, caseId);
      if (record.status !== "in_review") throw new AppError(409, `仅待复核态可核准（当前：${record.status}）`);
      if (record.submittedRevision !== record.revision || record.submittedContentHash !== record.contentHash) {
        throw new AppError(409, "报告内容已与提交版本不一致，请重新生成并提交");
      }
      await this.requireCurrentClassification(caseId, record);
      await this.requireCurrentContent(caseId, record);
      await this.requireCompleteContradictions(caseId);
      record.status = "approved";
      record.approvedRevision = record.revision;
      record.approvedContentHash = record.contentHash;
      record.reviewed_by = actor.id;
      record.approved_at = new Date().toISOString();
      await this.write(caseId, record);
      await this.audit.append({
        user: actor.id,
        action: "report.approve",
        object: `report:${caseId}`,
        caseId,
        // 一期不强制复核人 ≠ 起草人，但记录是否同人（§7.4）。
        detail: { caseId, revision: record.revision, contentHash: record.contentHash, samePerson: record.reviewed_by === record.drafted_by },
      });
      return record;
    });
  }

  async export(actor: Identity, caseId: string): Promise<ExportResult> {
    return this.queue.runExclusive(this.recordPath(caseId), async () => {
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
      if (record.approvedRevision !== record.revision || record.approvedContentHash !== record.contentHash) {
        throw new AppError(409, "报告内容已与审批版本不一致，禁止导出");
      }
      await this.requireCurrentClassification(caseId, record);
      const content = await this.requireCurrentContent(caseId, record);
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
      if (record.status === "approved") {
        record.status = "exported";
        record.exported_by = actor.id;
        record.exported_at = new Date().toISOString();
        await this.write(caseId, record);
      }
      await this.audit.append({ user: actor.id, action: "report.export", object: `report:${caseId}`, caseId, detail: { caseId, revision: record.revision, contentHash: record.contentHash } });
      return { filename: `${caseId}-bulletin.md`, content, status: record.status };
    });
  }

  async generateAutoDraft(actor: Identity, caseId: string): Promise<DraftInput> {
    const manifest = await this.cases.get(actor, caseId);
    const approvedFindings = (await readFindings(this.paths, caseId))
      .filter((finding) => finding.review_status === "approved" && this.isReportableFinding(finding));
    const sections = this.sectionsFromFindings(approvedFindings);
    const requiredClassification = this.requiredClassification(manifest, approvedFindings);

    const draft: DraftInput = {
      title: `${manifest.name} 情报分析报告`,
      classification: CLEARANCE_LABELS[requiredClassification],
      sections,
      finding_ids: approvedFindings.map((finding) => finding.id),
      date: new Date().toISOString().split("T")[0],
    };

    await this.audit.append({
      user: actor.id,
      action: "report.auto-draft",
      object: `report:${caseId}`,
      caseId,
      detail: {
        caseId,
        sectionsGenerated: sections.length,
        findingsCount: approvedFindings.length,
      },
    });

    return draft;
  }

  private async buildSpec(input: DraftInput, manifest: CaseManifest, caseId: string): Promise<BulletinSpec> {
    const title = input.title?.trim();
    if (!title) throw new AppError(400, "报告标题为必填项");
    const approvedFindings = (await readFindings(this.paths, caseId))
      .filter((finding) => finding.review_status === "approved" && this.isReportableFinding(finding));
    const sections = input.sections !== undefined
      ? input.sections.map((s) => this.normalizeSection(s)).filter((s) => s.heading || s.body || s.finding_ids.length > 0 || s.citation_ids.length > 0)
      : input.finding_ids !== undefined
        ? this.sectionsFromFindings(this.selectApprovedFindings(approvedFindings, input.finding_ids))
        : [];
    if (sections.length === 0 && input.body?.trim()) {
      sections.push(this.normalizeSection({ heading: "正文", body: input.body.trim() }));
    }
    if (sections.length === 0 && !input.body?.trim()) {
      sections.push(...this.sectionsFromFindings(approvedFindings));
    }
    const findingIds = new Set(sections.flatMap((section) => section.finding_ids));
    const referencedFindings = approvedFindings.filter((finding) => findingIds.has(finding.id));
    const requiredClassification = this.requiredClassification(manifest, referencedFindings);
    return {
      title,
      classification: this.validateClassification(input.classification, requiredClassification),
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
        heading: `已核准结论${index + 1}`,
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
    const approvedFindings = findings.filter((finding) => finding.review_status === "approved" && this.isReportableFinding(finding));
    const citationById = new Map<string, CitationPoolEntry>();
    for (const finding of approvedFindings) {
      for (const citation of finding.supporting_citations) {
        const id = citationId(citation);
        const entry = citationById.get(id);
        if (entry) entry.findingIds.add(finding.id);
        else citationById.set(id, { citation, findingIds: new Set([finding.id]) });
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
        } else if (!this.isReportableFinding(finding)) {
          reasons.add("citation:support-unverified");
        } else {
          sectionFindings.push(finding);
          reportFindings.set(finding.id, finding);
        }
      }
      let hasValidSpan = false;
      for (const id of citationIds) {
        const entry = citationById.get(id);
        if (!entry || (findingIds.length > 0 && !findingIds.some((findingId) => entry.findingIds.has(findingId)))) {
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
    if (!(await this.contradictionsComplete(caseId, chunks.length))) {
      reasons.add("contradiction:not-complete");
    }
    if (await this.hasHighSeverityContradiction(caseId)) {
      reasons.add("contradiction:high-severity-unresolved");
    }
    return [...reasons];
  }

  private validateCitation(citation: Citation, chunks: Chunk[]): CitationIntegrity {
    return validateCitationIntegrity(citation, chunks);
  }

  private validateFindingCitations(finding: Finding, chunks: Chunk[], reasons: Set<string>): { hasValidSpan: boolean } {
    let hasValidSpan = false;
    for (const citation of finding.supporting_citations) {
      if (citation.support_status === "support-unverified" || citation.support_status === "unsupported") {
        reasons.add("citation:support-unverified");
        continue;
      }
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

  /** 调 render_report.py 渲染到临时文件；只有成功读回完整 Markdown 才会由 draft 原子切换。 */
  private async render(caseId: string): Promise<string | null> {
    const outBase = path.join(this.reportDir(caseId), shortId("render-"));
    const renderedFile = `${outBase}.md`;
    try {
      await execFileAsync("python3", [bulletinScriptPath(), this.specPath(caseId), outBase], { timeout: 20_000 });
      return await readFile(renderedFile, "utf8");
    } catch {
      return null;
    } finally {
      await rm(renderedFile, { force: true }).catch(() => undefined);
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

  private contentHash(spec: BulletinSpec, markdown: string): string {
    return sha256(`${JSON.stringify(spec)}\n${markdown}`);
  }

  /** 核对 record/spec/Markdown 三者是同一版；旧 draft 仅在首次提交时就地绑定。 */
  private async requireCurrentContent(caseId: string, record: ReportRecord, upgradeLegacy = false): Promise<string> {
    if (!record.rendered) throw new AppError(409, "报告渲染失败，禁止提交、审批或导出");
    let diskSpec: BulletinSpec;
    let markdown: string;
    try {
      [diskSpec, markdown] = await Promise.all([
        readFile(this.specPath(caseId), "utf8").then((raw) => JSON.parse(raw) as BulletinSpec),
        readFile(this.markdownPath(caseId), "utf8"),
      ]);
    } catch {
      throw new AppError(409, "报告渲染产物缺失或损坏，请重新生成");
    }
    if (JSON.stringify(diskSpec) !== JSON.stringify(record.spec)) {
      throw new AppError(409, "报告 spec 已与状态记录不一致，请重新生成");
    }
    const currentHash = this.contentHash(record.spec, markdown);
    if ((!record.revision || !record.contentHash) && upgradeLegacy && record.status === "draft") {
      record.revision = 1;
      record.contentHash = currentHash;
      await this.write(caseId, record);
    }
    if (!record.revision || !record.contentHash || currentHash !== record.contentHash) {
      throw new AppError(409, "报告当前内容与记录版本不一致，请重新生成");
    }
    return markdown;
  }

  private async requireCompleteContradictions(caseId: string): Promise<void> {
    const chunks = await this.loadCaseChunks(caseId);
    if (!(await this.contradictionsComplete(caseId, chunks.length))) {
      throw new AppError(409, "矛盾检测未成功完成全量覆盖，禁止提交或审批报告");
    }
  }

  private async requireCurrentClassification(caseId: string, record: ReportRecord): Promise<void> {
    const manifest = await this.cases.loadManifest(caseId);
    if (!manifest) throw new AppError(404, "专题不存在");
    const ids = new Set(record.spec.sections.flatMap((section) => section.finding_ids));
    const referenced = (await readFindings(this.paths, caseId)).filter((finding) => ids.has(finding.id));
    const required = this.requiredClassification(manifest, referenced);
    const current = record.spec.classification ? this.parseClassification(record.spec.classification) : null;
    if (!current || clearanceRank(current) < clearanceRank(required)) {
      throw new AppError(409, `报告密级低于当前专题或引用证据密级（至少 ${CLEARANCE_LABELS[required]}），请重新生成`);
    }
  }

  private async contradictionsComplete(caseId: string, currentChunkCount: number): Promise<boolean> {
    const result = await this.readJson<{
      status?: string;
      processedChunks?: number;
      totalChunks?: number;
      truncated?: boolean;
      notStarted?: boolean;
    }>(path.join(this.paths.caseDir(caseId), "contradictions.result.json"));
    return result?.status === "succeeded"
      && result.notStarted !== true
      && result.truncated === false
      && Number.isInteger(result.processedChunks)
      && result.processedChunks === result.totalChunks
      && result.totalChunks === currentChunkCount;
  }

  private isReportableFinding(finding: Finding): boolean {
    return finding.supporting_citations.length > 0
      && finding.supporting_citations.every((citation) => citation.support_status !== "support-unverified" && citation.support_status !== "unsupported");
  }

  private requiredClassification(manifest: CaseManifest, findings: Finding[]): Clearance {
    let required = manifest.clearance;
    for (const finding of findings) {
      for (const citation of [...finding.supporting_citations, ...finding.opposing_citations]) {
        const raw = (citation as Citation & { classification?: unknown }).classification;
        const evidence = typeof raw === "string" ? this.parseClassification(raw) : null;
        if (evidence && clearanceRank(evidence) > clearanceRank(required)) required = evidence;
      }
    }
    return required;
  }

  private validateClassification(input: string | undefined, required: Clearance): string {
    const requested = input?.trim() ? this.parseClassification(input.trim()) : required;
    if (!requested) throw new AppError(400, "报告密级必须为内部/秘密/机密/绝密");
    if (clearanceRank(requested) < clearanceRank(required)) {
      throw new AppError(400, `报告密级不得低于专题或引用证据密级（至少 ${CLEARANCE_LABELS[required]}）`);
    }
    return CLEARANCE_LABELS[requested];
  }

  private parseClassification(value: string): Clearance | null {
    if ((CLEARANCES as readonly string[]).includes(value)) return value as Clearance;
    return CLEARANCES.find((clearance) => CLEARANCE_LABELS[clearance] === value) ?? null;
  }

  private async write(caseId: string, record: ReportRecord): Promise<void> {
    await mkdir(this.reportDir(caseId), { recursive: true });
    await writeFileAtomic(this.recordPath(caseId), `${JSON.stringify(record, null, 2)}\n`);
  }

  private async writeSpec(caseId: string, spec: BulletinSpec): Promise<void> {
    await mkdir(this.reportDir(caseId), { recursive: true });
    await writeFileAtomic(this.specPath(caseId), `${JSON.stringify(spec, null, 2)}\n`);
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
