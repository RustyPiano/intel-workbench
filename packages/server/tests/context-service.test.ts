import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContradictionService } from "../src/analysis/contradiction-service.js";
import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { estimateTokens, ContextService } from "../src/context/context-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Citation, Contradiction, ContradictionDetectionResult, Element, ElementType, Identity, Inquiry, InquiryClaim } from "../src/domain/types.js";
import { ElementService } from "../src/elements/element-service.js";
import { FindingService } from "../src/finding/finding-service.js";
import { chunkToCitation } from "../src/inquiry/citation.js";
import { InquiryService } from "../src/inquiry/inquiry-service.js";
import { MaterialService } from "../src/materials/material-service.js";
import { OfflineGuard } from "../src/security/offline-guard.js";

/**
 * ContextService 测试（智能工作流自动化决策文档 §阶段 2.1）。同 suggestion-service.test.ts
 * 的做法：questions/elements/contradictions/findings 均为已持久化产物，直接写 fixture
 * 文件驱动，不触发任何 LLM 调用；仅 Finding 相关用例走真实 FindingService.create（需要
 * 可校验引用）。
 */

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const SECURITY: Identity = { id: "sec", name: "sec", role: "security", clearance: "topsecret" };

function cite(hash: string, confidence = 0.8): Citation {
  return {
    material_id: "m1",
    material_name: "source.txt",
    modality: "doc",
    locator: { paragraph: 1 },
    snippet: hash,
    confidence,
    content_hash: hash,
  };
}

function el(id: string, name: string, type: ElementType, freq: number): Element {
  return { id, type, name, aliases: [], mentions: Array.from({ length: freq }, (_, i) => cite(`${id}-${i}`)), freq };
}

function contradiction(id: string, entity: string, confidence: number): Contradiction {
  return {
    id,
    entity,
    scope: "cross-material",
    claim_a: { text: `${entity}为甲`, citation: cite(`${id}-a`) },
    claim_b: { text: `${entity}为乙`, citation: cite(`${id}-b`) },
    relation: "contradiction",
    rationale: "测试矛盾",
    confidence,
  };
}

function contradictionResult(contradictions: Contradiction[]): ContradictionDetectionResult {
  return {
    status: "succeeded",
    contradictions,
    groundedPropositions: [],
    processedChunks: contradictions.length,
    totalChunks: contradictions.length,
    truncated: false,
    warnings: [],
  };
}

function inquiry(id: string, question: string): Inquiry {
  const claim: InquiryClaim = { text: `${question}的答案`, type: "fact", status: "verified", support_status: "supported", citations: [cite(id)] };
  return { id, ts: new Date().toISOString(), user: OPERATOR.id, question, status: "answered", answer: "", claims: [claim] };
}

describe("ContextService", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let materials: MaterialService;
  let inquiries: InquiryService;
  let findings: FindingService;
  let contradictions: ContradictionService;
  let elements: ElementService;
  let context: ContextService;
  let caseId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-context-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    materials = new MaterialService(paths, audit, cases);
    const guard = new OfflineGuard([], audit);
    const llm = { adapter: null, guard, modelEndpoint: "" };
    inquiries = new InquiryService(paths, audit, cases, materials, llm);
    findings = new FindingService(paths, audit, cases);
    contradictions = new ContradictionService(paths, audit, cases, materials, llm);
    elements = new ElementService(paths, audit, cases, materials, llm);
    context = new ContextService(cases, materials, elements, contradictions, inquiries, findings);
    caseId = (await cases.create(OPERATOR, { name: "上下文测试专题", clearance: "internal" })).id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeElements(list: Element[]): Promise<void> {
    const file = path.join(paths.caseDir(caseId), "elements.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(list, null, 2), "utf8");
  }

  async function writeContradictions(list: Contradiction[]): Promise<void> {
    const file = path.join(paths.caseDir(caseId), "contradictions.result.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(contradictionResult(list), null, 2), "utf8");
  }

  async function writeInquiries(list: Inquiry[]): Promise<void> {
    const file = path.join(paths.caseDir(caseId), "inquiries.jsonl");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, list.map((i) => JSON.stringify(i)).join("\n") + (list.length ? "\n" : ""), "utf8");
  }

  async function validCitation(text = "目标甲在码头出现。"): Promise<Citation> {
    await materials.ingest(OPERATOR, caseId, [{ filename: `intel-${Date.now()}-${Math.random()}.txt`, content: `前情。${text}后续。` }]);
    const chunks = await materials.loadCaseChunks(caseId);
    const chunk = chunks[chunks.length - 1]!;
    return { ...chunkToCitation(chunk, "intel.txt", 0.9, text), support_status: "supported" };
  }

  describe("estimateTokens", () => {
    it("折算约 4 字符 = 1 token（字符串直接折算）", () => {
      expect(estimateTokens("abcd")).toBe(1);
      expect(estimateTokens("a".repeat(400))).toBe(100);
      expect(estimateTokens("")).toBe(0);
    });

    it("非字符串先 JSON 序列化再折算", () => {
      const value = { a: 1, b: "test" };
      expect(estimateTokens(value)).toBe(Math.ceil(JSON.stringify(value).length / 4));
    });
  });

  describe("buildContext", () => {
    it("空专题返回空数组而非报错", async () => {
      const result = await context.buildContext(OPERATOR, caseId, "suggest-questions");
      expect(result.case.id).toBe(caseId);
      expect(result.materials).toEqual([]);
      expect(result.elements).toEqual([]);
      expect(result.contradictions).toEqual([]);
      expect(result.inquiries).toEqual([]);
      expect(result.findings).toEqual([]);
      expect(result.estimatedTokens).toBeGreaterThanOrEqual(0);
    });

    it("按密级校验访问权限：低密级 actor 访问高密级专题应被拒绝", async () => {
      const secretCaseId = (await cases.create(SECURITY, { name: "机密专题", clearance: "secret" })).id;
      await expect(context.buildContext(OPERATOR, secretCaseId, "suggest-questions")).rejects.toMatchObject({ status: 403 });
    });

    it("要素按频次降序排列，且按用途上限截断（suggest-questions=20，verify-claims=15）", async () => {
      const list = Array.from({ length: 25 }, (_, i) => el(`e${i}`, `要素${i}`, "person", 25 - i));
      await writeElements(list);

      const forSuggest = await context.buildContext(OPERATOR, caseId, "suggest-questions");
      expect(forSuggest.elements).toHaveLength(20);
      expect(forSuggest.elements[0]!.freq).toBe(25);

      const forVerify = await context.buildContext(OPERATOR, caseId, "verify-claims");
      expect(forVerify.elements).toHaveLength(15);
      expect(forVerify.elements[0]!.freq).toBe(25);
    });

    it("矛盾按置信度降序，问答按时间新旧降序", async () => {
      await writeContradictions([contradiction("c1", "甲", 0.5), contradiction("c2", "乙", 0.9)]);
      await writeInquiries([inquiry("i1", "问题一"), inquiry("i2", "问题二")]);

      const result = await context.buildContext(OPERATOR, caseId, "suggest-questions");
      expect(result.contradictions.map((c) => c.entity)).toEqual(["乙", "甲"]);
      expect(result.inquiries).toHaveLength(2);
    });

    it("素材摘要按用途截断长度不同（suggest-questions 200 字符，verify-claims 400 字符）", async () => {
      const longText = "关键情报线索。".repeat(100); // 远超两个用途的截断上限
      await materials.ingest(OPERATOR, caseId, [{ filename: "long.txt", content: longText }]);

      const forSuggest = await context.buildContext(OPERATOR, caseId, "suggest-questions");
      expect(forSuggest.materials[0]!.excerpt.length).toBeLessThanOrEqual(200);

      const forVerify = await context.buildContext(OPERATOR, caseId, "verify-claims");
      expect(forVerify.materials[0]!.excerpt.length).toBeLessThanOrEqual(400);
      expect(forVerify.materials[0]!.excerpt.length).toBeGreaterThan(forSuggest.materials[0]!.excerpt.length);
    });

    it("30 秒缓存窗口内复用同一 purpose 的聚合结果；不同 purpose 各自独立计算", async () => {
      await writeElements([el("e1", "要素一", "person", 1), el("e2", "要素二", "person", 2)]);

      const first = await context.buildContext(OPERATOR, caseId, "suggest-questions");
      expect(first.elements).toHaveLength(2);

      // 缓存窗口内直接改写底层数据：suggest-questions 的第二次调用应命中缓存，仍看到旧数据。
      await writeElements([el("e1", "要素一", "person", 1), el("e2", "要素二", "person", 2), el("e3", "要素三", "person", 3)]);
      const second = await context.buildContext(OPERATOR, caseId, "suggest-questions");
      expect(second.elements).toHaveLength(2);

      // 不同 purpose 是独立缓存键，首次调用必然重新计算，能看到最新数据。
      const otherPurpose = await context.buildContext(OPERATOR, caseId, "generate-report");
      expect(otherPurpose.elements).toHaveLength(3);
    });

    it("token 预算裁剪：按置信度优先保留 finding，从最低置信度开始丢弃，materials 至少保留 1 条", async () => {
      const supportCitation = await validCitation();
      await findings.create(OPERATOR, caseId, { conclusion: "结论A", supporting_citations: [supportCitation], confidence: 0.9 });
      await findings.create(OPERATOR, caseId, { conclusion: "结论B", supporting_citations: [supportCitation], confidence: 0.8 });
      await findings.create(OPERATOR, caseId, { conclusion: "结论C", supporting_citations: [supportCitation], confidence: 0.4 });
      await findings.create(OPERATOR, caseId, { conclusion: "结论D", supporting_citations: [supportCitation], confidence: 0.2 });

      const full = await context.buildContext(OPERATOR, caseId, "generate-report", { maxTokens: 1_000_000 });
      expect(full.findings).toHaveLength(4);

      const trimmed = await context.buildContext(OPERATOR, caseId, "generate-report", { maxTokens: full.estimatedTokens - 1 });
      expect(trimmed.findings.length).toBeLessThan(4);
      expect(trimmed.findings.some((f) => f.confidence === 0.2)).toBe(false);
      expect(trimmed.findings.some((f) => f.confidence === 0.9)).toBe(true);
      expect(trimmed.materials.length).toBeGreaterThanOrEqual(1);
      expect(trimmed.estimatedTokens).toBeLessThanOrEqual(full.estimatedTokens);
    });

    it("极小预算下裁剪到只剩 1 条素材，其余数组清空", async () => {
      const supportCitation = await validCitation();
      await findings.create(OPERATOR, caseId, { conclusion: "结论A", supporting_citations: [supportCitation], confidence: 0.9 });
      await writeElements([el("e1", "要素一", "person", 5)]);
      await writeContradictions([contradiction("c1", "甲", 0.9)]);
      await writeInquiries([inquiry("i1", "问题一")]);

      const trimmed = await context.buildContext(OPERATOR, caseId, "suggest-questions", { maxTokens: 1 });
      expect(trimmed.findings).toEqual([]);
      expect(trimmed.contradictions).toEqual([]);
      expect(trimmed.inquiries).toEqual([]);
      expect(trimmed.elements).toEqual([]);
      expect(trimmed.materials.length).toBe(1);
    });
  });
});
