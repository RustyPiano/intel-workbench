import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { ContradictionService } from "../src/analysis/contradiction-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Chunk, Citation, Contradiction, Finding, Identity } from "../src/domain/types.js";
import { FindingService } from "../src/finding/finding-service.js";
import { chunkToCitation } from "../src/inquiry/citation.js";
import { MaterialService } from "../src/materials/material-service.js";
import type { LlmDeps } from "../src/model/structured.js";
import { citationId, ReportService } from "../src/report/report-service.js";
import type { OfflineGuard } from "../src/security/offline-guard.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const SECURITY: Identity = { id: "sec", name: "sec", role: "security", clearance: "topsecret" };

describe("ReportService 复核闸门状态机（§7.4）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let materials: MaterialService;
  let findings: FindingService;
  let contradictions: ContradictionService;
  let reports: ReportService;
  let caseId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-rep-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    materials = new MaterialService(paths, audit, cases);
    findings = new FindingService(paths, audit, cases);
    contradictions = new ContradictionService(paths, audit, cases, materials, { adapter: null, guard: { authorize: async () => undefined } as unknown as OfflineGuard, modelEndpoint: "" } satisfies LlmDeps);
    reports = new ReportService(paths, audit, cases);
    caseId = (await cases.create(OPERATOR, { name: "报告专题", clearance: "internal" })).id;
    await seedCompleteContradictions();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function approvedFinding(conclusion = "目标甲在码头出现。"): Promise<Finding> {
    await materials.ingest(OPERATOR, caseId, [
      { filename: "intel.txt", content: `前情。${conclusion}后续。` },
    ]);
    const chunk = (await materials.loadCaseChunks(caseId))[0];
    const citation = { ...chunkToCitation(chunk, "intel.txt", 0.9, conclusion), support_status: "supported" as const };
    const finding = await findings.create(OPERATOR, caseId, {
      conclusion,
      supporting_citations: [citation],
      confidence: 0.9,
    });
    await seedCompleteContradictions();
    return findings.review(SECURITY, caseId, finding.id, { review_status: "approved" });
  }

  async function quoteLessApprovedFinding(conclusion = "目标甲在码头出现。"): Promise<Finding> {
    await materials.ingest(OPERATOR, caseId, [
      { filename: "legacy.txt", content: `前情。${conclusion}后续。` },
    ]);
    const chunk = (await materials.loadCaseChunks(caseId))[0];
    const citation = chunkToCitation(chunk, "legacy.txt", 0.9);
    const finding: Finding = {
      id: "f-legacy",
      caseId,
      conclusion,
      supporting_citations: [citation],
      opposing_citations: [],
      confidence: 0.9,
      review_status: "approved",
      reviewed_by: SECURITY.id,
      reviewed_at: new Date().toISOString(),
      open_questions: [],
    };
    await writeFile(path.join(paths.caseDir(caseId), "findings.json"), `${JSON.stringify([finding], null, 2)}\n`, "utf8");
    await seedCompleteContradictions();
    return finding;
  }

  async function seedCompleteContradictions(items: Array<{ id?: string; confidence?: number }> = []): Promise<void> {
    const count = materials ? (await materials.loadCaseChunks(caseId)).length : 0;
    await writeFile(
      path.join(paths.caseDir(caseId), "contradictions.result.json"),
      `${JSON.stringify({ status: "succeeded", contradictions: items, groundedPropositions: [], processedChunks: count, totalChunks: count, truncated: false, warnings: [] }, null, 2)}\n`,
      "utf8",
    );
  }

  async function approveReportFromFinding(finding: Finding): Promise<void> {
    await reports.draft(OPERATOR, caseId, { title: "网络入侵分析通报", finding_ids: [finding.id] });
    await reports.submit(OPERATOR, caseId);
    await reports.approve(SECURITY, caseId);
  }

  async function expectExportRejected(reason: string): Promise<string[]> {
    let thrown: unknown;
    try {
      await reports.export(OPERATOR, caseId);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({
      status: 409,
      result: {
        reasons: expect.arrayContaining([reason]),
      },
    });
    const reasons = ((thrown as { result?: { reasons?: string[] } }).result?.reasons ?? []);
    const events = await audit.readAll();
    expect(events.some((event) => event.action === "report.export.gate" && event.result === "deny" && event.detail?.reason === reason)).toBe(true);
    return reasons;
  }

  async function approveReport(input: Parameters<ReportService["draft"]>[2]): Promise<void> {
    await reports.draft(OPERATOR, caseId, input);
    await reports.submit(OPERATOR, caseId);
    await reports.approve(SECURITY, caseId);
  }

  async function tamperFirstChunk(rewrite: (chunk: Chunk) => Chunk): Promise<void> {
    const chunks = await materials.loadCaseChunks(caseId);
    const tampered = rewrite(chunks[0]);
    await writeFile(
      path.join(paths.caseDir(caseId), "processed", `${tampered.material_id}.chunks.jsonl`),
      `${JSON.stringify(tampered)}\n`,
      "utf8",
    );
  }

  it("draft 落 spec 并渲染 .md，状态 draft，密级默认取专题", async () => {
    const rec = await reports.draft(OPERATOR, caseId, { title: "关于某情况的通报", body: "基本情况说明。" });
    expect(rec.status).toBe("draft");
    expect(rec.spec.classification).toBe("内部");
    expect(rec.rendered).toBe(true);
    await expect(access(path.join(paths.caseDir(caseId), "report", "bulletin.md"))).resolves.toBeUndefined();
  });

  it("未复核态导出被拒（红线），并落 deny 审计", async () => {
    await reports.draft(OPERATOR, caseId, { title: "通报", body: "正文" });
    await expect(reports.export(OPERATOR, caseId)).rejects.toMatchObject({ status: 409 });
    const events = await audit.readAll();
    expect(events.some((e) => e.action === "report.export" && e.result === "deny")).toBe(true);
  });

  it("走完 draft→submit→approve→export，导出入审计", async () => {
    const finding = await approvedFinding("发现可疑横向渗透。");
    await reports.draft(OPERATOR, caseId, { title: "网络入侵分析通报", finding_ids: [finding.id] });
    const draft = await reports.get(OPERATOR, caseId);
    expect(draft?.spec.sections[0]).toMatchObject({
      finding_ids: [finding.id],
      citation_ids: [citationId(finding.supporting_citations[0])],
      coverage_status: "covered",
    });
    expect((await reports.submit(OPERATOR, caseId)).status).toBe("in_review");
    const approved = await reports.approve(SECURITY, caseId);
    expect(approved.status).toBe("approved");
    expect(approved.revision).toBeGreaterThan(0);
    expect(approved.submittedRevision).toBe(approved.revision);
    expect(approved.approvedRevision).toBe(approved.revision);
    expect(approved.submittedContentHash).toBe(approved.contentHash);
    expect(approved.approvedContentHash).toBe(approved.contentHash);

    const exported = await reports.export(OPERATOR, caseId);
    expect(exported.status).toBe("exported");
    expect(exported.content).toContain("网络入侵分析通报");
    const events = await audit.readAll();
    expect(events.some((e) => e.action === "report.export.gate" && e.result === "ok")).toBe(true);
    expect(events.some((e) => e.action === "report.export" && e.result === "ok")).toBe(true);
  });

  it("作业员无权复核核准 → 403", async () => {
    await reports.draft(OPERATOR, caseId, { title: "通报", body: "正文" });
    await reports.submit(OPERATOR, caseId);
    await expect(reports.approve(OPERATOR, caseId)).rejects.toMatchObject({ status: 403 });
  });

  it("已核准后再编辑 → 回到 draft（复核失效）", async () => {
    await reports.draft(OPERATOR, caseId, { title: "通报", body: "正文" });
    await reports.submit(OPERATOR, caseId);
    await reports.approve(SECURITY, caseId);
    const rec = await reports.draft(OPERATOR, caseId, { title: "通报（修订）", body: "新正文" });
    expect(rec.status).toBe("draft");
    expect(rec.submittedRevision).toBeUndefined();
    expect(rec.approvedRevision).toBeUndefined();
    expect(rec.reviewed_by).toBeUndefined();
  });

  it("关键结论可由 referenced Finding 的 span citation 覆盖，即使 citation_ids 为空", async () => {
    const finding = await approvedFinding();
    await reports.draft(OPERATOR, caseId, {
      title: "通报",
      sections: [{
        heading: "已核准结论",
        body: finding.conclusion,
        finding_ids: [finding.id],
        citation_ids: [],
        coverage_status: "uncovered",
        key_conclusion: true,
      }],
    });
    await reports.submit(OPERATOR, caseId);
    await reports.approve(SECURITY, caseId);

    await expect(reports.export(OPERATOR, caseId)).resolves.toMatchObject({ status: "exported" });
  });

  it("T1: summary 中无 Finding/span 支撑的事实会被 coverage:uncited-fact 拒绝", async () => {
    const finding = await approvedFinding("目标甲在码头出现。");
    await approveReport({
      title: "通报",
      summary: "目标乙已经离开码头。",
      finding_ids: [finding.id],
    });

    await expectExportRejected("coverage:uncited-fact");
  });

  it("T2: key conclusion 只有 quote-less citation 时返回 citation:no-span", async () => {
    const finding = await quoteLessApprovedFinding();
    await approveReport({ title: "通报", finding_ids: [finding.id] });

    await expectExportRejected("citation:no-span");
  });

  it("T3: citation-only section 借用 rejected Finding 的 citation 会被 citation:invalid 拒绝", async () => {
    const finding = await approvedFinding("目标甲在码头出现。");
    await findings.review(SECURITY, caseId, finding.id, { review_status: "rejected" });
    await approveReport({
      title: "通报",
      sections: [{
        heading: "事实",
        body: finding.conclusion,
        finding_ids: [],
        citation_ids: [citationId(finding.supporting_citations[0])],
        coverage_status: "covered",
      }],
    });

    await expectExportRejected("citation:invalid");
  });

  it("T4: section 只有 finding_ids 也会重校 Finding supporting_citations", async () => {
    const finding = await approvedFinding("目标甲在码头出现。");
    await approveReport({
      title: "通报",
      sections: [{
        heading: "事实",
        body: finding.conclusion,
        finding_ids: [finding.id],
        citation_ids: [],
        coverage_status: "covered",
      }],
    });
    await tamperFirstChunk((chunk) => ({ ...chunk, text: "被篡改的正文" }));

    await expectExportRejected("citation:invalid");
  });

  it("T5: section body 偏离 referenced Finding conclusion 会被 coverage:body-unsupported 拒绝", async () => {
    const finding = await approvedFinding("目标甲在码头出现。");
    await approveReport({
      title: "通报",
      sections: [{
        heading: "事实",
        body: "目标甲已经转移到二号码头。",
        finding_ids: [finding.id],
        citation_ids: [citationId(finding.supporting_citations[0])],
        coverage_status: "covered",
      }],
    });

    await expectExportRejected("coverage:body-unsupported");
  });

  it("section heading 中无 Finding/span 支撑的事实会被 coverage:uncited-fact 拒绝", async () => {
    await approveReport({
      title: "通报",
      sections: [{
        heading: "目标甲在码头出现。",
        body: "",
        finding_ids: [],
        citation_ids: [],
        coverage_status: "uncovered",
      }],
    });

    await expectExportRejected("coverage:uncited-fact");
  });

  it("导出闸拒绝当前素材 hash 或 quote 校验失效的引用", async () => {
    const finding = await approvedFinding();
    await approveReportFromFinding(finding);
    await tamperFirstChunk((chunk) => ({ ...chunk, text: "被篡改的正文" }));

    await expectExportRejected("citation:invalid");
  });

  it("导出闸拒绝引用已驳回 Finding 的报告", async () => {
    const finding = await approvedFinding();
    await approveReportFromFinding(finding);
    await findings.review(SECURITY, caseId, finding.id, { review_status: "rejected" });

    await expectExportRejected("finding:rejected");
  });

  it("T8: unresolved high-severity contradiction blocks export; resolved 后放行", async () => {
    const finding = await approvedFinding();
    await approveReportFromFinding(finding);
    await seedCompleteContradictions([{ id: "ct-1", confidence: 0.75 }]);

    await expectExportRejected("contradiction:high-severity-unresolved");
    await contradictions.acknowledge(SECURITY, caseId, "ct-1", { status: "resolved", note: "人工复核已解释来源差异" });

    await expect(reports.export(OPERATOR, caseId)).resolves.toMatchObject({ status: "exported" });
  });

  it("legacy contradictions.json 中未解决高置信矛盾也会阻止导出", async () => {
    const finding = await approvedFinding();
    await approveReportFromFinding(finding);
    const citation = finding.supporting_citations[0];
    const contradiction: Contradiction = {
      id: "ct-legacy",
      entity: "目标甲",
      scope: "cross-material",
      claim_a: { text: "目标甲在码头出现。", citation },
      claim_b: { text: "目标甲未在码头出现。", citation },
      relation: "contradiction",
      rationale: "历史矛盾检测结果仅保存在 legacy 文件中。",
      confidence: 0.9,
    };
    await writeFile(path.join(paths.caseDir(caseId), "contradictions.json"), `${JSON.stringify([contradiction], null, 2)}\n`, "utf8");
    await rm(path.join(paths.caseDir(caseId), "contradictions.result.json"), { force: true });

    await expectExportRejected("contradiction:high-severity-unresolved");
  });

  it("T9: exported report can be exported again after the full gate re-runs", async () => {
    const finding = await approvedFinding();
    await approveReportFromFinding(finding);

    await expect(reports.export(OPERATOR, caseId)).resolves.toMatchObject({ status: "exported" });
    const second = await reports.export(OPERATOR, caseId);

    expect(second.status).toBe("exported");
    expect(second.content).toContain("网络入侵分析通报");
  });

  it("T10: multiple export gate failures are returned together as a set", async () => {
    await approveReport({
      title: "通报",
      sections: [{
        heading: "模型生成事实",
        body: "目标甲已经转移到二号码头。",
        finding_ids: [],
        citation_ids: ["missing:citation:id"],
        coverage_status: "uncovered",
      }],
    });
    await seedCompleteContradictions([{ id: "ct-2", confidence: 0.9 }]);

    const reasons = await expectExportRejected("coverage:uncited-fact");
    expect(reasons).toEqual(expect.arrayContaining([
      "coverage:uncited-fact",
      "citation:invalid",
      "contradiction:high-severity-unresolved",
    ]));
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it("渲染失败删除旧 Markdown，且禁止提交", async () => {
    const first = await reports.draft(OPERATOR, caseId, { title: "旧报告", body: "旧正文" });
    expect(first.rendered).toBe(true);
    const savedScript = process.env.WORKBENCH_BULLETIN_SCRIPT;
    process.env.WORKBENCH_BULLETIN_SCRIPT = path.join(root, "missing-renderer.py");
    try {
      const second = await reports.draft(OPERATOR, caseId, { title: "新报告", body: "新正文" });
      expect(second).toMatchObject({ status: "draft", rendered: false, revision: (first.revision ?? 0) + 1 });
      expect(second.contentHash).toBeUndefined();
      await expect(access(path.join(paths.caseDir(caseId), "report", "bulletin.md"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(reports.submit(OPERATOR, caseId)).rejects.toMatchObject({ status: 409 });
    } finally {
      if (savedScript === undefined) delete process.env.WORKBENCH_BULLETIN_SCRIPT;
      else process.env.WORKBENCH_BULLETIN_SCRIPT = savedScript;
    }
  });

  it("审批前或审批后正文被替换都会 409 fail-closed", async () => {
    const finding = await approvedFinding();
    await reports.draft(OPERATOR, caseId, { title: "通报", finding_ids: [finding.id] });
    await reports.submit(OPERATOR, caseId);
    const markdown = path.join(paths.caseDir(caseId), "report", "bulletin.md");
    const original = await readFile(markdown, "utf8");
    await writeFile(markdown, `${original}\n未经提交的修改`, "utf8");
    await expect(reports.approve(SECURITY, caseId)).rejects.toMatchObject({ status: 409 });

    await reports.draft(OPERATOR, caseId, { title: "通报", finding_ids: [finding.id] });
    await reports.submit(OPERATOR, caseId);
    await reports.approve(SECURITY, caseId);
    await writeFile(markdown, `${await readFile(markdown, "utf8")}\n未经审批的修改`, "utf8");
    await expect(reports.export(OPERATOR, caseId)).rejects.toMatchObject({ status: 409 });
  });

  it("矛盾检测失败、截断或与当前 chunk 数不一致均禁止提交", async () => {
    await reports.draft(OPERATOR, caseId, { title: "通报", body: "正文" });
    const file = path.join(paths.caseDir(caseId), "contradictions.result.json");
    for (const result of [
      { status: "failed", processedChunks: 0, totalChunks: 0, truncated: false },
      { status: "succeeded", processedChunks: 0, totalChunks: 1, truncated: true },
      { status: "succeeded", processedChunks: 1, totalChunks: 1, truncated: false },
    ]) {
      await writeFile(file, `${JSON.stringify({ ...result, contradictions: [], groundedPropositions: [], warnings: [] })}\n`, "utf8");
      await expect(reports.submit(OPERATOR, caseId)).rejects.toMatchObject({ status: 409 });
    }
  });

  it("报告密级不得低于专题或所引证据最高密级", async () => {
    await materials.ingest(OPERATOR, caseId, [{ filename: "classified.txt", content: "目标甲在码头出现。" }]);
    const chunk = (await materials.loadCaseChunks(caseId))[0];
    const citation = {
      ...chunkToCitation(chunk, "classified.txt", 0.9, "目标甲在码头出现。"),
      support_status: "supported" as const,
      classification: "topsecret",
    } as Citation & { classification: string };
    const finding = await findings.create(OPERATOR, caseId, { conclusion: "目标甲在码头出现。", supporting_citations: [citation] });
    await findings.review(SECURITY, caseId, finding.id, { review_status: "approved" });
    await seedCompleteContradictions();

    await expect(reports.draft(OPERATOR, caseId, { title: "低密级通报", classification: "机密", finding_ids: [finding.id] }))
      .rejects.toMatchObject({ status: 400 });
    await expect(reports.draft(OPERATOR, caseId, { title: "正确密级通报", finding_ids: [finding.id] }))
      .resolves.toMatchObject({ spec: { classification: "绝密" } });
  });

  it("旧数据中含 support-unverified 引用的 Finding 不进入报告候选", async () => {
    await materials.ingest(OPERATOR, caseId, [{ filename: "unverified.txt", content: "待核线索。" }]);
    const chunk = (await materials.loadCaseChunks(caseId))[0];
    const citation = { ...chunkToCitation(chunk, "unverified.txt", 0.8, "待核线索。"), support_status: "support-unverified" as const };
    const legacy: Finding = {
      id: "f-unverified",
      caseId,
      conclusion: "待核线索。",
      supporting_citations: [citation],
      opposing_citations: [],
      confidence: 0.8,
      review_status: "approved",
      open_questions: [],
    };
    await writeFile(path.join(paths.caseDir(caseId), "findings.json"), `${JSON.stringify([legacy], null, 2)}\n`, "utf8");

    await expect(reports.generateAutoDraft(OPERATOR, caseId)).resolves.toMatchObject({ sections: [], finding_ids: [] });
    await expect(reports.draft(OPERATOR, caseId, { title: "通报", finding_ids: [legacy.id] })).rejects.toMatchObject({ status: 400 });
  });

  it("同专题并发草稿串行化，最终 record/spec/Markdown 仍为同一 revision", async () => {
    await Promise.all(Array.from({ length: 5 }, (_unused, index) => reports.draft(OPERATOR, caseId, {
      title: `并发通报 ${index}`,
      body: `正文 ${index}`,
    })));

    const record = await reports.get(OPERATOR, caseId);
    expect(record?.revision).toBe(5);
    expect(record?.contentHash).toBeTruthy();
    await expect(reports.submit(OPERATOR, caseId)).resolves.toMatchObject({ status: "in_review", revision: 5 });
    await expect(reports.approve(SECURITY, caseId)).resolves.toMatchObject({ status: "approved", revision: 5 });
  });
});
