import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Citation, Finding, Identity } from "../src/domain/types.js";
import { FindingService } from "../src/finding/finding-service.js";
import { readFindings, replaceFindings } from "../src/finding/finding-store.js";
import { chunkToCitation } from "../src/inquiry/citation.js";
import { MaterialService } from "../src/materials/material-service.js";
import { citationId, ReportService } from "../src/report/report-service.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const SECURITY: Identity = { id: "sec", name: "sec", role: "security", clearance: "topsecret" };

describe("ReportService citation id and export-gate pool", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let materials: MaterialService;
  let findings: FindingService;
  let reports: ReportService;
  let caseId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-rep-pool-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit);
    materials = new MaterialService(paths, audit, cases);
    findings = new FindingService(paths, audit, cases);
    reports = new ReportService(paths, audit, cases);
    caseId = (await cases.create(OPERATOR, { name: "报告专题", clearance: "internal" })).id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function approve(finding: Finding): Promise<Finding> {
    return findings.review(SECURITY, caseId, finding.id, { review_status: "approved" });
  }

  async function approveReport(input: Parameters<ReportService["draft"]>[2]): Promise<void> {
    const count = (await materials.loadCaseChunks(caseId)).length;
    await writeFile(
      path.join(paths.caseDir(caseId), "contradictions.result.json"),
      `${JSON.stringify({ status: "succeeded", contradictions: [], groundedPropositions: [], processedChunks: count, totalChunks: count, truncated: false, warnings: [] }, null, 2)}\n`,
      "utf8",
    );
    await reports.draft(OPERATOR, caseId, input);
    await reports.submit(OPERATOR, caseId);
    await reports.approve(SECURITY, caseId);
  }

  async function createApprovedFinding(conclusion: string, citation: Citation): Promise<Finding> {
    const finding = await findings.createFromCitations(OPERATOR, caseId, {
      conclusion,
      supporting_citations: [citation],
      confidence: 0.9,
    });
    return approve(finding);
  }

  it("allows two approved findings to share one citation without last-write-wins invalidation", async () => {
    await materials.ingest(OPERATOR, caseId, [
      { filename: "intel.txt", content: "目标甲在码头出现。" },
    ]);
    const chunk = (await materials.loadCaseChunks(caseId))[0];
    const citation = { ...chunkToCitation(chunk, "intel.txt", 0.9, "目标甲在码头出现。"), verdict: "supports" as const };
    const first = await createApprovedFinding("目标甲在码头出现。", citation);
    await createApprovedFinding("码头出现目标甲。", citation);

    await approveReport({
      title: "通报",
      sections: [{
        heading: "事实",
        body: first.conclusion,
        finding_ids: [first.id],
        citation_ids: [citationId(citation)],
        coverage_status: "covered",
      }],
    });

    await expect(reports.export(OPERATOR, caseId)).resolves.toMatchObject({ status: "exported" });
  });

  it("keeps citation ids distinct for the same sentence at different offsets in one chunk", async () => {
    await materials.ingest(OPERATOR, caseId, [
      { filename: "intel.txt", content: "目标甲在码头出现。背景。目标甲在码头出现。" },
    ]);
    const chunk = (await materials.loadCaseChunks(caseId))[0];
    const first = chunkToCitation(chunk, "intel.txt", 0.9, "目标甲在码头出现。", 0);
    const second = chunkToCitation(chunk, "intel.txt", 0.9, "目标甲在码头出现。", 12);

    expect(citationId(first)).not.toBe(citationId(second));
  });

  it("keeps citation ids distinct for the same sentence in different chunks", async () => {
    await materials.ingest(OPERATOR, caseId, [
      { filename: "a.txt", content: "前情。目标甲在码头出现。" },
      { filename: "b.txt", content: "目标甲在码头出现。后续。" },
    ]);
    const [firstChunk, secondChunk] = await materials.loadCaseChunks(caseId);
    const first = chunkToCitation(firstChunk, "a.txt", 0.9, "目标甲在码头出现。");
    const second = chunkToCitation(secondChunk, "b.txt", 0.9, "目标甲在码头出现。");

    expect(first.content_hash).not.toBe(second.content_hash);
    expect(citationId(first)).not.toBe(citationId(second));
  });

  it("keeps citation ids distinct for identical text at different locators", async () => {
    await materials.ingest(OPERATOR, caseId, [{ filename: "intel.txt", content: "目标甲在码头出现。" }]);
    const chunk = (await materials.loadCaseChunks(caseId))[0];
    const base = chunkToCitation(chunk, "intel.txt", 0.9, "目标甲在码头出现。", 0);
    // 同素材、同文本(content_hash 相同)、同 quote/偏移，仅来源位置(locator)不同 —— 必须区分。
    const otherLocator: Citation = { ...base, locator: { ...base.locator, timecode: "10-12" } };

    expect(base.content_hash).toBe(otherLocator.content_hash);
    expect(base.quote_hash).toBe(otherLocator.quote_hash);
    expect(citationId(base)).not.toBe(citationId(otherLocator));
  });

  it("keeps the remaining finding valid after deleting another finding with the same citation", async () => {
    await materials.ingest(OPERATOR, caseId, [
      { filename: "intel.txt", content: "目标甲在码头出现。" },
    ]);
    const chunk = (await materials.loadCaseChunks(caseId))[0];
    const citation = { ...chunkToCitation(chunk, "intel.txt", 0.9, "目标甲在码头出现。"), verdict: "supports" as const };
    await createApprovedFinding("码头出现目标甲。", citation);
    const remaining = await createApprovedFinding("目标甲在码头出现。", citation);
    await replaceFindings(paths, caseId, (await readFindings(paths, caseId)).filter((finding) => finding.id === remaining.id));

    await approveReport({ title: "通报", finding_ids: [remaining.id] });

    await expect(reports.export(OPERATOR, caseId)).resolves.toMatchObject({ status: "exported" });
  });

  it("generates deterministic citation ids for the same input", async () => {
    await materials.ingest(OPERATOR, caseId, [
      { filename: "intel.txt", content: "目标甲在码头出现。" },
    ]);
    const chunk = (await materials.loadCaseChunks(caseId))[0];
    const citation = chunkToCitation(chunk, "intel.txt", 0.9, "目标甲在码头出现。");

    expect(citationId({ ...citation })).toBe(citationId({ ...citation }));
  });

  it("includes locator in quote-less citation ids", async () => {
    await materials.ingest(OPERATOR, caseId, [
      { filename: "intel.txt", content: "目标甲在码头出现。" },
    ]);
    const chunk = (await materials.loadCaseChunks(caseId))[0];
    const first = chunkToCitation(chunk, "intel.txt", 0.9);
    const second = { ...first, locator: { ...first.locator, paragraph: 2 } };

    expect(citationId(first)).not.toBe(citationId(second));
  });
});
