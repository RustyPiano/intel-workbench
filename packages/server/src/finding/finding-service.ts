import { readFile } from "node:fs/promises";
import path from "node:path";

import { FileMutationQueue } from "mini-agent";

import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import { AppError } from "../domain/identity.js";
import type { CaseManifest, Chunk, Citation, Finding, FindingReviewStatus, Identity, InquiryClaim } from "../domain/types.js";
import { validateCitationIntegrity } from "../inquiry/citation.js";
import { findingsFilePath, readFindings, replaceFindings } from "./finding-store.js";
import { shortId } from "../util/hash.js";

export interface CreateFindingInput {
  claim?: InquiryClaim;
  conclusion?: string;
  supporting_citations?: Citation[];
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

  async create(actor: Identity, caseId: string, input: CreateFindingInput): Promise<Finding> {
    const manifest = await this.cases.get(actor, caseId);
    if (!this.canCreate(actor, manifest)) {
      await this.auditCreateDeny(actor, caseId, "role");
      throw new AppError(403, "仅专题创建者或管理员可创建 Finding");
    }
    const fromClaim = input.claim;
    if (fromClaim && !this.canPromoteClaim(fromClaim)) {
      await this.auditCreateDeny(actor, caseId, "unsupported-claim");
      throw new AppError(400, "仅可从 supported 结论创建 Finding");
    }

    const conclusion = (fromClaim?.text ?? input.conclusion ?? "").trim();
    if (!conclusion) {
      await this.auditCreateDeny(actor, caseId, "empty-conclusion");
      throw new AppError(400, "Finding 结论不能为空");
    }

    const chunks = await this.loadCaseChunks(manifest);
    const supporting = fromClaim
      ? this.promotableCitations(fromClaim).filter((citation) => this.citationStillValid(citation, chunks))
      : (input.supporting_citations ?? []);
    const opposing = input.opposing_citations ?? [];
    const unverifiedSupporting = supporting.some((citation) => citation.support_status === "support-unverified" || citation.support_status === "unsupported");
    const unverifiedOpposing = opposing.some((citation) => citation.support_status === "support-unverified"
      || (citation.support_status === "unsupported" && citation.support_label !== "contradicts"));
    if (unverifiedSupporting || unverifiedOpposing) {
      await this.auditCreateDeny(actor, caseId, "citation:not-supported");
      throw new AppError(400, "Finding 不得包含未通过支持性校验的引用");
    }
    if (supporting.length === 0) {
      await this.auditCreateDeny(actor, caseId, "missing-supporting-citation");
      throw new AppError(400, "Finding 至少需要一条支持引用");
    }
    const confidence = input.confidence ?? this.defaultConfidence(supporting);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      await this.auditCreateDeny(actor, caseId, "confidence");
      throw new AppError(400, "Finding 置信度必须在 0 到 1 之间");
    }
    if (![...supporting, ...opposing].every((citation) => this.citationStillValid(citation, chunks))) {
      await this.auditCreateDeny(actor, caseId, "citation:invalid");
      throw new AppError(400, "Finding 引用必须匹配当前素材 span");
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
      detail: { caseId, findingId: finding.id, fromClaim: Boolean(fromClaim), citationCount: supporting.length },
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

  private canPromoteClaim(claim: InquiryClaim): boolean {
    if (claim.support_status === "unsupported" || claim.support_status === "support-unverified") return false;
    if (claim.support_status === "supported") return this.promotableCitations(claim).length > 0;
    return claim.status === "verified" && this.promotableCitations(claim).length > 0;
  }

  private promotableCitations(claim: InquiryClaim): Citation[] {
    // 旧版 verified claim 没有 support_status，保留兼容；显式 unverified/unsupported 不得晋升。
    return claim.citations.filter((citation) => citation.support_status === undefined || citation.support_status === "supported");
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
