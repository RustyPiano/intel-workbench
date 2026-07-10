import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Citation, Contradiction, ContradictionAcknowledgement, Element, Finding, Identity } from "../src/domain/types.js";
import { MaterialService } from "../src/materials/material-service.js";
import { computeCoverage, type CoverageSection, type CoverageSectionKey } from "../src/report/coverage.js";
import { ReportService } from "../src/report/report-service.js";
import type { InquiryBatchItem, WorkflowState, WorkflowStepStatus } from "../src/workflow/types.js";

/**
 * 报告覆盖率仪表测试（阶段三 M4 / D4）。computeCoverage 是只读纯函数，用 fixture 直写
 * elements.json / contradictions.result.json / contradiction-acks.json / findings.json /
 * workflow.json 驱动五节判定。核验：各节满足/不满足口径、缺口明细文案、无数据专题
 * 不抛错、ReportService.getCoverage 委派 + 密级闸门。
 */

/** 构造仅关心 inquiries 步骤的合法 workflow.json（其余步骤置 succeeded 以过契约校验）。 */
function workflowWith(status: WorkflowStepStatus, statuses: InquiryBatchItem["status"][]): WorkflowState {
  return {
    inputHash: "test-hash",
    steps: {
      elements: { status: "succeeded" },
      contradictions: { status: "succeeded" },
      inquiries: { status, items: statuses.map((s, i) => ({ question: `q${i}`, status: s })) },
    },
    checkpoints: {},
  };
}

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const TOPSECRET: Identity = { id: "boss", name: "boss", role: "operator", clearance: "topsecret" };

describe("报告覆盖率仪表（阶段三 M4）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let materials: MaterialService;
  let caseId: string;
  let contentHash: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-cov-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    materials = new MaterialService(paths, audit, cases);
    caseId = (await cases.create(OPERATOR, { name: "覆盖度专题", clearance: "internal" })).id;
    await materials.ingest(OPERATOR, caseId, [{ filename: "intel.txt", content: "目标甲于码头出现。随后驶离港口。" }]);
    contentHash = (await materials.loadCaseChunks(caseId))[0]!.content_hash;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeCaseJson(file: string, value: unknown): Promise<void> {
    const target = path.join(paths.caseDir(caseId), file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  function cite(): Citation {
    return { material_id: "m", material_name: "intel.txt", modality: "doc", locator: { paragraph: 1 }, snippet: "线索", confidence: 0.8, content_hash: contentHash };
  }

  function timeElement(name: string): Element {
    return { id: `el-${name}`, type: "time", name, aliases: [], mentions: [cite()], freq: 1 };
  }

  function finding(id: string, status: Finding["review_status"]): Finding {
    return { id, caseId, conclusion: `结论${id}`, supporting_citations: [cite()], opposing_citations: [], confidence: 0.8, review_status: status, open_questions: [] };
  }

  function highContradiction(id: string, confidence: number): Contradiction {
    return { id, entity: "目标甲", scope: "cross-material", claim_a: { text: "在码头", citation: cite() }, claim_b: { text: "在港外", citation: cite() }, relation: "contradiction", rationale: "位置冲突", confidence };
  }

  async function coverage() {
    const manifest = await cases.get(OPERATOR, caseId);
    return computeCoverage(paths, caseId, manifest);
  }

  function section(sections: CoverageSection[], key: CoverageSectionKey): CoverageSection {
    return sections.find((s) => s.key === key)!;
  }

  it("五节结构完整、含标题与行动引导；无数据时不抛错（仅矛盾节因无高置信矛盾而空满足）", async () => {
    const cov = await coverage();
    expect(cov.totalSections).toBe(5);
    expect(cov.sections.map((s) => s.key)).toEqual(["background", "timeline", "contradiction", "conclusion", "open-items"]);
    // 每节都带非空标题、明细、行动短语与目标 Tab。
    for (const s of cov.sections) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.detail.length).toBeGreaterThan(0);
      expect(s.action.tab.length).toBeGreaterThan(0);
      expect(s.action.label.length).toBeGreaterThan(0);
    }
    // 素材已加工 → 背景满足；无矛盾 → 矛盾节空满足；其余缺口。
    expect(section(cov.sections, "background").satisfied).toBe(true);
    expect(section(cov.sections, "timeline").satisfied).toBe(false);
    expect(section(cov.sections, "contradiction")).toMatchObject({ satisfied: true, detail: "未检出高置信矛盾" });
    expect(section(cov.sections, "conclusion").satisfied).toBe(false);
    expect(section(cov.sections, "open-items")).toMatchObject({ satisfied: false, detail: "自动研判尚未运行，待核问题未闭环" });
    expect(cov.satisfiedCount).toBe(2);
  });

  it("背景与素材概况：加工完成 ≥1 满足，否则缺口明细报 done/total", async () => {
    // 当前 fixture 已 ingest 1 份 → 满足。
    expect(section((await coverage()).sections, "background")).toMatchObject({ satisfied: true, detail: "已加工完成 1/1 份素材" });

    // 无素材专题：total=0 → 缺口文案「尚未上传任何素材」。
    const emptyCase = (await cases.create(OPERATOR, { name: "空专题", clearance: "internal" })).id;
    const emptyManifest = await cases.get(OPERATOR, emptyCase);
    const bg = section((await computeCoverage(paths, emptyCase, emptyManifest)).sections, "background");
    expect(bg).toMatchObject({ satisfied: false, detail: "尚未上传任何素材" });
  });

  it("关键时间线：锚定时间点 ≥3 满足，否则缺口明细报 anchored/3", async () => {
    await writeCaseJson("elements.json", [timeElement("2026年1月1日"), timeElement("2026年2月1日")]);
    expect(section((await coverage()).sections, "timeline")).toMatchObject({ satisfied: false, detail: "已锚定 2/3 个时间点，尚不足以支撑时间线" });

    await writeCaseJson("elements.json", [timeElement("2026年1月1日"), timeElement("2026年2月1日"), timeElement("2026年3月1日")]);
    expect(section((await coverage()).sections, "timeline")).toMatchObject({ satisfied: true, detail: "已锚定 3 个时间点" });
  });

  it("矛盾核验：未处置高置信矛盾阻断，处置后满足；低置信不计入", async () => {
    const result = { status: "succeeded", contradictions: [highContradiction("ct-1", 0.9), highContradiction("ct-2", 0.8), highContradiction("ct-low", 0.5)], groundedPropositions: [], processedChunks: 1, totalChunks: 1, truncated: false, warnings: [] };
    await writeCaseJson("contradictions.result.json", result);
    // ct-low(0.5) 不算高置信；ct-1、ct-2 高置信且未处置 → 2/2 未处置。
    expect(section((await coverage()).sections, "contradiction")).toMatchObject({ satisfied: false, detail: "2/2 条高置信矛盾未处置" });

    const acks: ContradictionAcknowledgement[] = [
      { id: "a1", case_id: caseId, contradiction_id: "ct-1", status: "resolved", note: "", by: "sec", at: "t" },
      { id: "a2", case_id: caseId, contradiction_id: "ct-2", status: "dismissed", note: "", by: "sec", at: "t" },
    ];
    await writeCaseJson("contradiction-acks.json", acks);
    expect(section((await coverage()).sections, "contradiction")).toMatchObject({ satisfied: true, detail: "2 条高置信矛盾均已处置" });
  });

  it("研判结论：≥1 条已核准满足，否则缺口计候选数", async () => {
    await writeCaseJson("findings.json", [finding("f1", "draft"), finding("f2", "draft")]);
    expect(section((await coverage()).sections, "conclusion")).toMatchObject({ satisfied: false, detail: "尚无已核准结论（2 条候选待复核）" });

    await writeCaseJson("findings.json", [finding("f1", "approved"), finding("f2", "draft")]);
    expect(section((await coverage()).sections, "conclusion")).toMatchObject({ satisfied: true, detail: "已核准 1 条结论" });
  });

  it("未决事项：批次进行中/悬空题目缺口，全部闭环满足", async () => {
    // 进行中（completed 由 items 派生：done/candidate/failed 计为已完成）。
    await writeCaseJson("workflow.json", workflowWith("running", ["done", "running", "pending"]));
    expect(section((await coverage()).sections, "open-items")).toMatchObject({ satisfied: false, detail: "自动研判进行中（1/3）" });

    // 已跑完但有失败题 → 悬空。
    await writeCaseJson("workflow.json", workflowWith("failed", ["candidate", "failed"]));
    expect(section((await coverage()).sections, "open-items")).toMatchObject({ satisfied: false, detail: "1/2 个待核问题仍悬空（未产生候选或失败）" });

    // 全部闭环（candidate/done）→ 满足。
    await writeCaseJson("workflow.json", workflowWith("succeeded", ["candidate", "done"]));
    expect(section((await coverage()).sections, "open-items")).toMatchObject({ satisfied: true, detail: "2 个待核问题均已闭环" });
  });

  it("全部满足 → satisfiedCount=5", async () => {
    await writeCaseJson("elements.json", [timeElement("2026年1月1日"), timeElement("2026年2月1日"), timeElement("2026年3月1日")]);
    await writeCaseJson("contradictions.result.json", { status: "succeeded", contradictions: [highContradiction("ct-1", 0.9)], groundedPropositions: [], processedChunks: 1, totalChunks: 1, truncated: false, warnings: [] });
    await writeCaseJson("contradiction-acks.json", [{ id: "a1", case_id: caseId, contradiction_id: "ct-1", status: "resolved", note: "", by: "sec", at: "t" }]);
    await writeCaseJson("findings.json", [finding("f1", "approved")]);
    await writeCaseJson("workflow.json", workflowWith("succeeded", ["candidate"]));

    const cov = await coverage();
    expect(cov.satisfiedCount).toBe(5);
    expect(cov.sections.every((s) => s.satisfied)).toBe(true);
  });

  it("ReportService.getCoverage 委派 computeCoverage 并经密级闸门收口", async () => {
    const reports = new ReportService(paths, audit, cases);
    const cov = await reports.getCoverage(OPERATOR, caseId);
    expect(cov.totalSections).toBe(5);
    expect(cov.satisfiedCount).toBe(2);

    // 密级不足的专题：getCoverage 复用 cases.get 访问闸门 → 拒绝。
    const secretCase = (await cases.create(TOPSECRET, { name: "涉密", clearance: "secret" })).id;
    await expect(reports.getCoverage(OPERATOR, secretCase)).rejects.toThrow();
  });
});
