import { readFile } from "node:fs/promises";
import path from "node:path";

import { FileMutationQueue } from "mini-agent";

import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import { AppError } from "../domain/identity.js";
import type { CaseManifest, Chunk, Citation, Finding, FindingReviewStatus, Identity, Inquiry } from "../domain/types.js";
import { aggregateSupport, validateCitationIntegrity } from "../inquiry/citation.js";
import { parseInquiries } from "../inquiry/inquiry-service.js";
import { findingsFilePath, readFindings, replaceFindings } from "./finding-store.js";
import { shortId } from "../util/hash.js";

/** HTTP 晋升入参（Batch A）：只收结论引用，服务端从 inquiries.jsonl 加载并重校验，杜绝客户端伪造支持性。 */
export interface CreateFindingInput {
  inquiryId?: string;
  claimId?: string;
  confidence?: number;
}

export type PromotionReason = "not-supported" | "no-valid-citation" | "already-promoted";

export type CreateFindingResult =
  | { ok: true; finding: Finding }
  | { ok: false; status: number; reason: PromotionReason };

/** 服务端内部 API（不经 HTTP）：从 conclusion + 已校验引用建 Finding，供建议采纳（含矛盾/时间线来源）。 */
export interface CreateFromCitationsInput {
  conclusion: string;
  supporting_citations: Citation[];
  opposing_citations?: Citation[];
  confidence?: number;
  open_questions?: string[];
}

export interface ReviewFindingInput {
  review_status: Extract<FindingReviewStatus, "approved" | "rejected">;
}

export class FindingService {
  private readonly queue = new FileMutationQueue();

  constructor(
    private readonly paths: DataPaths,
    private readonly audit: AuditService,
    private readonly cases: CaseService,
  ) {}

  /**
   * 从某条问答结论晋升为 Finding（HTTP 入口）。服务端自 inquiries.jsonl 加载对应 claim，
   * 逐条 span 重校验取有效引用，基于有效引用的 verdict 重算 support；仅当 support===supported
   * 且至少一条有效 supports 引用、且该 claim 未晋升过才创建。支持性语义一律由服务端裁定，杜绝客户端伪造。
   */
  async create(actor: Identity, caseId: string, input: CreateFindingInput): Promise<CreateFindingResult> {
    const manifest = await this.cases.get(actor, caseId);
    if (!this.canCreate(actor, manifest)) {
      await this.auditCreateDeny(actor, caseId, "role");
      throw new AppError(403, "仅专题创建者或管理员可创建 Finding");
    }
    const inquiryId = (input.inquiryId ?? "").trim();
    const claimId = (input.claimId ?? "").trim();
    if (!inquiryId || !claimId) {
      await this.auditCreateDeny(actor, caseId, "missing-claim-ref");
      throw new AppError(400, "创建 Finding 需提供 inquiryId 与 claimId");
    }

    const inquiry = (await this.loadInquiries(caseId)).find((item) => item.id === inquiryId);
    const claim = inquiry?.claims.find((item) => item.id === claimId);
    if (!claim) {
      await this.auditCreateDeny(actor, caseId, "claim-not-found");
      throw new AppError(404, "对应的问答结论不存在");
    }

    // already-promoted：同一 (inquiryId, claimId) 已晋升过。
    const existing = await readFindings(this.paths, caseId);
    if (existing.some((finding) => finding.source_claim?.inquiryId === inquiryId && finding.source_claim?.claimId === claimId)) {
      await this.auditCreateDeny(actor, caseId, "already-promoted");
      return { ok: false, status: 409, reason: "already-promoted" };
    }

    // 逐条 span 重校验 → 有效引用；基于有效引用的 verdict 重算 support。
    const chunks = await this.loadCaseChunks(manifest);
    const valid = claim.citations.filter((citation) => this.citationStillValid(citation, chunks));
    if (valid.length === 0 || !valid.some((citation) => citation.verdict === "supports")) {
      await this.auditCreateDeny(actor, caseId, "no-valid-citation");
      return { ok: false, status: 400, reason: "no-valid-citation" };
    }
    if (aggregateSupport(valid, true) !== "supported") {
      await this.auditCreateDeny(actor, caseId, "not-supported");
      return { ok: false, status: 400, reason: "not-supported" };
    }

    const conclusion = claim.text.trim();
    const confidence = input.confidence ?? this.defaultConfidence(valid);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      await this.auditCreateDeny(actor, caseId, "confidence");
      throw new AppError(400, "Finding 置信度必须在 0 到 1 之间");
    }
    const finding: Finding = {
      id: shortId("f-"),
      caseId,
      conclusion,
      supporting_citations: valid,
      opposing_citations: [],
      confidence,
      review_status: "draft",
      open_questions: [],
      source_claim: { inquiryId, claimId },
    };
    await this.mutate(caseId, (findings) => {
      findings.push(finding);
    });
    await this.audit.append({
      user: actor.id,
      action: "finding.create",
      object: `finding:${finding.id}`,
      caseId,
      detail: { caseId, findingId: finding.id, inquiryId, claimId, citationCount: valid.length },
    });
    return { ok: true, finding };
  }

  /**
   * 服务端内部 API：从 conclusion + 已校验引用建 Finding。仅供 SuggestionService.applyFinding 采纳
   * 建议使用（内容由服务端生成，含矛盾/时间线/结构化研判来源，不可伪造），不暴露于任何 HTTP 请求体。
   * 引用须逐条 span 重校验；支持性已由建议引擎上游按 verdict 过滤。
   */
  async createFromCitations(actor: Identity, caseId: string, input: CreateFromCitationsInput): Promise<Finding> {
    const manifest = await this.cases.get(actor, caseId);
    if (!this.canCreate(actor, manifest)) {
      await this.auditCreateDeny(actor, caseId, "role");
      throw new AppError(403, "仅专题创建者或管理员可创建 Finding");
    }
    const conclusion = input.conclusion.trim();
    if (!conclusion) {
      await this.auditCreateDeny(actor, caseId, "empty-conclusion");
      throw new AppError(400, "Finding 结论不能为空");
    }
    const supporting = input.supporting_citations;
    const opposing = input.opposing_citations ?? [];
    if (supporting.length === 0) {
      await this.auditCreateDeny(actor, caseId, "missing-supporting-citation");
      throw new AppError(400, "Finding 至少需要一条支持引用");
    }
    const chunks = await this.loadCaseChunks(manifest);
    if (![...supporting, ...opposing].every((citation) => this.citationStillValid(citation, chunks))) {
      await this.auditCreateDeny(actor, caseId, "citation:invalid");
      throw new AppError(400, "Finding 引用必须匹配当前素材 span");
    }
    const confidence = input.confidence ?? this.defaultConfidence(supporting);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      await this.auditCreateDeny(actor, caseId, "confidence");
      throw new AppError(400, "Finding 置信度必须在 0 到 1 之间");
    }
    const finding: Finding = {
      id: shortId("f-"),
      caseId,
      conclusion,
      supporting_citations: supporting,
      opposing_citations: opposing,
      confidence,
      review_status: "draft",
      open_questions: (input.open_questions ?? []).map((q) => q.trim()).filter(Boolean),
    };
    await this.mutate(caseId, (findings) => {
      findings.push(finding);
    });
    await this.audit.append({
      user: actor.id,
      action: "finding.create",
      object: `finding:${finding.id}`,
      caseId,
      detail: { caseId, findingId: finding.id, fromCitations: true, citationCount: supporting.length },
    });
    return finding;
  }

  async list(actor: Identity, caseId: string): Promise<Finding[]> {
    await this.cases.get(actor, caseId);
    return readFindings(this.paths, caseId);
  }

  async filterValidCitations(actor: Identity, caseId: string, citations: Citation[]): Promise<Citation[]> {
    const manifest = await this.cases.get(actor, caseId);
    const chunks = await this.loadCaseChunks(manifest);
    return citations.filter((citation) => this.citationStillValid(citation, chunks));
  }

  async review(actor: Identity, caseId: string, findingId: string, input: ReviewFindingInput): Promise<Finding> {
    await this.cases.get(actor, caseId);
    if (actor.role !== "security" && actor.role !== "admin") {
      await this.auditReviewDeny(actor, caseId, findingId, "role");
      throw new AppError(403, "仅保密员或管理员可复核 Finding");
    }
    if (input.review_status !== "approved" && input.review_status !== "rejected") {
      await this.auditReviewDeny(actor, caseId, findingId, "invalid-status");
      throw new AppError(400, "非法 Finding 复核状态");
    }
    let reviewed: Finding | undefined;
    await this.mutate(caseId, async (findings) => {
      const finding = findings.find((item) => item.id === findingId);
      if (!finding) {
        await this.auditReviewDeny(actor, caseId, findingId, "not-found");
        throw new AppError(404, "Finding 不存在");
      }
      finding.review_status = input.review_status;
      finding.reviewed_by = actor.id;
      finding.reviewed_at = new Date().toISOString();
      reviewed = finding;
    });
    await this.audit.append({
      user: actor.id,
      action: "finding.review",
      object: `finding:${findingId}`,
      caseId,
      detail: { caseId, findingId, review_status: input.review_status },
    });
    return reviewed as Finding;
  }

  private canCreate(actor: Identity, manifest: CaseManifest): boolean {
    return actor.role === "admin" || manifest.owner === actor.id;
  }

  private async loadInquiries(caseId: string): Promise<Inquiry[]> {
    try {
      return parseInquiries(await readFile(path.join(this.paths.caseDir(caseId), "inquiries.jsonl"), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  private defaultConfidence(citations: Citation[]): number {
    if (citations.length === 0) return 0.5;
    return citations.reduce((sum, citation) => sum + citation.confidence, 0) / citations.length;
  }

  private citationStillValid(citation: Citation, chunks: Chunk[]): boolean {
    // Finding 侧契约比报告侧更严：每条引用必须有逐字 span（quote+hash+偏移命中），
    // 不接受 missingSpan（无 quote 的引用）。统一校验器只给三态结果，各调用方按自己契约取舍。
    const validation = validateCitationIntegrity(citation, chunks);
    return validation.validChunk && validation.validSpan;
  }

  private async loadCaseChunks(manifest: CaseManifest): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    for (const material of manifest.materials) {
      if (material.status !== "done") continue;
      try {
        const raw = await readFile(path.join(this.paths.caseDir(manifest.id), "processed", `${material.id}.chunks.jsonl`), "utf8");
        chunks.push(...raw.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Chunk));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    return chunks;
  }

  private async auditCreateDeny(actor: Identity, caseId: string, reason: string): Promise<void> {
    await this.audit.append({
      user: actor.id,
      action: "finding.create",
      object: `case:${caseId}`,
      result: "deny",
      caseId,
      detail: { caseId, reason },
    });
  }

  private async auditReviewDeny(actor: Identity, caseId: string, findingId: string, reason: string): Promise<void> {
    await this.audit.append({
      user: actor.id,
      action: "finding.review",
      object: `finding:${findingId}`,
      result: "deny",
      caseId,
      detail: { caseId, findingId, reason },
    });
  }

  private async mutate<T>(caseId: string, mutate: (findings: Finding[]) => T | Promise<T>): Promise<T> {
    const file = findingsFilePath(this.paths, caseId);
    return this.queue.runExclusive(file, async () => {
      const findings = await readFindings(this.paths, caseId);
      const result = await mutate(findings);
      await replaceFindings(this.paths, caseId, findings);
      return result;
    });
  }
}
