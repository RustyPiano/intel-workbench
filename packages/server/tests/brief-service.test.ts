import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContradictionService } from "../src/analysis/contradiction-service.js";
import { AuditService } from "../src/audit/audit-service.js";
import { BriefService } from "../src/brief/brief-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Citation, Contradiction, ContradictionAcknowledgement, ContradictionDetectionResult, Element, Finding, Identity } from "../src/domain/types.js";
import { ElementService } from "../src/elements/element-service.js";
import { FindingService } from "../src/finding/finding-service.js";
import { MaterialService } from "../src/materials/material-service.js";
import type { LlmDeps } from "../src/model/structured.js";
import { OfflineGuard } from "../src/security/offline-guard.js";

/**
 * BriefService 测试（破坏性收敛 R2 · 批次 D）。简报已改为**确定性投影**：只读落盘产物
 * （elements.json / contradictions.result.json / contradiction-acks.json / findings.json），
 * 无缓存、无指纹、无 LLM、无出站、GET 不写盘不落审计。核心校验：同产物两次调用一致、
 * 无模型配置也输出完整简报、高置信阈值 0.75 过滤、不产生 brief.json、不落审计、密级收口。
 */

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const TOPSECRET: Identity = { id: "boss", name: "boss", role: "operator", clearance: "topsecret" };

describe("BriefService（确定性投影）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let materials: MaterialService;
  let elements: ElementService;
  let contradictions: ContradictionService;
  let findings: FindingService;
  let briefs: BriefService;
  let caseId: string;
  let contentHash: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-brief-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit);
    materials = new MaterialService(paths, audit, cases);
    const baseLlm: LlmDeps = { adapter: null, guard: new OfflineGuard([], audit), modelEndpoint: "" };
    elements = new ElementService(paths, audit, cases, materials, baseLlm);
    findings = new FindingService(paths, audit, cases);
    contradictions = new ContradictionService(paths, audit, cases, materials, baseLlm);
    briefs = new BriefService(paths, cases, elements, contradictions, findings);

    caseId = (await cases.create(OPERATOR, { name: "简报专题", clearance: "internal" })).id;
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
    return { material_id: "m1", material_name: "intel.txt", modality: "doc", locator: { paragraph: 1 }, snippet: "线索", confidence: 0.8, content_hash: contentHash, verdict: "supports" };
  }

  function contradiction(id: string, confidence: number, rationale = "位置冲突"): Contradiction {
    return {
      id,
      entity: "目标甲",
      attribute: "位置",
      scope: "cross-material",
      claim_a: { text: "在码头", citation: cite() },
      claim_b: { text: "在港外", citation: cite() },
      relation: "contradiction",
      rationale,
      confidence,
    };
  }

  function finding(id: string, review_status: Finding["review_status"], conclusion: string): Finding {
    return { id, caseId, conclusion, supporting_citations: [cite()], opposing_citations: [], confidence: 0.8, review_status, open_questions: [] };
  }

  /** 播种：2 要素、3 矛盾（0.9 open / 0.8 resolved / 0.5 low）、2 结论（f1 approved / f2 draft）。 */
  async function seedProducts(): Promise<void> {
    const els: Element[] = [
      { id: "el-time", type: "time", name: "2026年3月1日", aliases: [], mentions: [cite()], freq: 3 },
      { id: "el-person", type: "person", name: "目标甲", aliases: [], mentions: [cite()], freq: 5 },
    ];
    await writeCaseJson("elements.json", els);

    const result: ContradictionDetectionResult = {
      status: "succeeded",
      contradictions: [contradiction("ct-1", 0.9), contradiction("ct-2", 0.8), contradiction("ct-3", 0.5)],
      groundedPropositions: [],
      processedChunks: 1,
      totalChunks: 1,
      truncated: false,
      warnings: [],
    };
    await writeCaseJson("contradictions.result.json", result);
    // ct-2（高置信）已处置为 resolved → 应被排除；ct-1 open、ct-3 低置信。
    const acks: ContradictionAcknowledgement[] = [
      { id: "ca-1", case_id: caseId, contradiction_id: "ct-2", status: "resolved", note: "已核实", by: "sec", at: "2026-03-02T00:00:00.000Z" },
    ];
    await writeCaseJson("contradiction-acks.json", acks);

    await writeCaseJson("findings.json", [finding("f1", "approved", "目标甲已确认在码头活动"), finding("f2", "draft", "候选结论")]);
  }

  it("六板块投影：概览+时间线+关键要素+未处置高置信矛盾+已核准Finding+覆盖率", async () => {
    await seedProducts();
    const brief = await briefs.getBrief(OPERATOR, caseId);

    // 概览：已核准 Finding 结论排首，附其引用；矛盾理由入句。
    expect(brief.overview.length).toBeGreaterThanOrEqual(2);
    expect(brief.overview[0]).toMatchObject({ text: "目标甲已确认在码头活动" });
    expect(brief.overview[0].citation.content_hash).toBe(contentHash);
    expect(brief.overview.some((s) => s.text === "位置冲突")).toBe(true);

    // 未处置高置信矛盾：仅 ct-1（0.9 open）；ct-2 已处置、ct-3 低置信均排除。
    expect(brief.contradictions.map((c) => c.id)).toEqual(["ct-1"]);

    expect(brief.approvedFindings.map((f) => f.id)).toEqual(["f1"]);
    expect(brief.entities.map((e) => e.name)).toEqual(["目标甲", "2026年3月1日"]);
    expect(brief.timeline.length).toBeGreaterThanOrEqual(1);
    expect(brief.timeline[0].label).toBe("2026年3月1日");

    // 覆盖率：本 fixture 满足背景+结论 2 节。
    expect(brief.coverage).toMatchObject({ satisfiedCount: 2, totalSections: 5 });
    expect(brief.caseId).toBe(caseId);
  });

  it("同一份产物两次调用结果完全一致（确定性，无时间戳/随机）", async () => {
    await seedProducts();
    const first = await briefs.getBrief(OPERATOR, caseId);
    const second = await briefs.getBrief(OPERATOR, caseId);
    expect(second).toEqual(first);
  });

  it("无模型配置也输出完整简报（无 LLM 依赖，概览确定性派生自产物）", async () => {
    await seedProducts();
    const brief = await briefs.getBrief(OPERATOR, caseId);
    expect(brief.overview.length).toBeGreaterThan(0);
    expect(brief.approvedFindings).toHaveLength(1);
    expect(brief.contradictions).toHaveLength(1);
  });

  it("GET 不产生 brief.json、不落审计事件", async () => {
    await seedProducts();
    await briefs.getBrief(OPERATOR, caseId);
    await expect(access(path.join(paths.caseDir(caseId), "brief.json"))).rejects.toThrow();
    const events = await audit.readCaseEvents(caseId);
    expect(events.some((e) => e.action.startsWith("brief"))).toBe(false);
  });

  it("空产物专题：各板块为空但不报错（无矛盾/结论文件亦可投影）", async () => {
    const brief = await briefs.getBrief(OPERATOR, caseId);
    expect(brief.overview).toEqual([]);
    expect(brief.contradictions).toEqual([]);
    expect(brief.approvedFindings).toEqual([]);
    expect(brief.entities).toEqual([]);
  });

  it("密级不足 → getBrief 拒绝（复用 cases.get 访问闸门）", async () => {
    const secretCase = (await cases.create(TOPSECRET, { name: "涉密专题", clearance: "secret" })).id;
    await expect(briefs.getBrief(OPERATOR, secretCase)).rejects.toThrow();
  });
});
