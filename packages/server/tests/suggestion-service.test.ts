import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ModelAdapter } from "mini-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContradictionService } from "../src/analysis/contradiction-service.js";
import { ElementGraphService } from "../src/analysis/element-graph-service.js";
import { PromptStore } from "../src/admin/prompt-store.js";
import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { ContextService } from "../src/context/context-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Citation, Contradiction, ContradictionDetectionResult, Element, ElementType, Identity, Inquiry, InquiryClaim, InquirySubmittedFinding } from "../src/domain/types.js";
import { ElementService } from "../src/elements/element-service.js";
import { FindingService } from "../src/finding/finding-service.js";
import { chunkToCitation } from "../src/inquiry/citation.js";
import { InquiryService } from "../src/inquiry/inquiry-service.js";
import { MaterialService } from "../src/materials/material-service.js";
import { PromptService } from "../src/prompt/prompt-service.js";
import { OfflineGuard } from "../src/security/offline-guard.js";
import { SuggestionService } from "../src/suggestion/suggestion-service.js";

/**
 * SuggestionService 测试（智能工作流自动化决策文档 §阶段 1 规则引擎 + §阶段 2.3 LLM 增强）。
 * suggestQuestions / suggestFindings 只读已持久化产物（elements.json /
 * contradictions.result.json / inquiries.jsonl），不触发任何 LLM 调用，
 * 故这里直接写入 fixture 文件驱动规则分支，无需真实抽取/检测流水线。
 * 唯有 applyFinding 会落盘真实 Finding，须走真实素材摄入以拿到可校验引用。
 * suggestQuestionsWithLLM 用脚本化 ModelAdapter 模拟 LLM 返回，不出真实网络。
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
    support_status: "supported",
  };
}

function el(id: string, name: string, type: ElementType, hashes: string[]): Element {
  return { id, name, type, aliases: [], mentions: hashes.map((hash) => cite(hash)), freq: hashes.length };
}

function contradiction(id: string, entity: string, attribute: string, confidence: number): Contradiction {
  return {
    id,
    entity,
    attribute,
    scope: "cross-material",
    claim_a: { text: `${entity}${attribute}为甲`, citation: cite(`${id}-a`) },
    claim_b: { text: `${entity}${attribute}为乙`, citation: cite(`${id}-b`) },
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

function claim(text: string, opts: Partial<InquiryClaim> = {}): InquiryClaim {
  return { text, type: "fact", status: "verified", support_status: "supported", citations: [cite(text)], ...opts };
}

function inquiry(id: string, claims: InquiryClaim[], submittedFindings?: InquirySubmittedFinding[]): Inquiry {
  return {
    id,
    ts: new Date().toISOString(),
    user: OPERATOR.id,
    question: `问题-${id}`,
    status: "answered",
    answer: "",
    claims,
    ...(submittedFindings ? { submitted_findings: submittedFindings } : {}),
  };
}

describe("SuggestionService", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let materials: MaterialService;
  let inquiries: InquiryService;
  let findings: FindingService;
  let contradictions: ContradictionService;
  let elements: ElementService;
  let elementGraph: ElementGraphService;
  let context: ContextService;
  let promptService: PromptService;
  let suggestions: SuggestionService;
  let caseId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-suggest-"));
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
    elementGraph = new ElementGraphService(elements);
    context = new ContextService(cases, materials, elements, contradictions, inquiries, findings);
    promptService = new PromptService(new PromptStore(paths, audit), audit);
    // 默认无 LLM（adapter: null）：suggestQuestionsWithLLM 的"未配置 LLM 时的行为"由这个默认实例覆盖；
    // "已配置 LLM"的用例各自 new 一个带脚本化 adapter 的 SuggestionService（见 suggestQuestionsWithLLM 描述块）。
    suggestions = new SuggestionService(audit, inquiries, findings, contradictions, elementGraph, context, promptService, llm);
    caseId = (await cases.create(OPERATOR, { name: "建议测试专题", clearance: "internal" })).id;
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

  describe("suggestQuestions", () => {
    it("always includes the two basic questions, even with no other signal", async () => {
      const result = await suggestions.suggestQuestions(OPERATOR, caseId);
      expect(result.map((s) => s.category)).toEqual(["basic", "basic"]);
      expect(result.map((s) => s.question)).toEqual(["这些材料中涉及哪些关键人物？", "主要涉及哪些组织机构？"]);
      expect(result.every((s) => s.priority >= 1 && s.priority <= 5)).toBe(true);
    });

    it("adds one contradiction question per unique entity+attribute above the 0.7 threshold, sorted first", async () => {
      await writeContradictions([
        contradiction("ct-1", "甲船", "位置", 0.85),
        contradiction("ct-2", "甲船", "位置", 0.6), // 同实体属性但低置信度 → 不计入（去重取更早出现者）
        contradiction("ct-3", "乙组织", "规模", 0.9),
      ]);

      const result = await suggestions.suggestQuestions(OPERATOR, caseId);
      const contradictionQs = result.filter((s) => s.category === "contradiction");
      expect(contradictionQs).toHaveLength(2);
      expect(contradictionQs.map((s) => s.question)).toEqual([
        "关于甲船的位置，哪个说法更可信？",
        "关于乙组织的规模，哪个说法更可信？",
      ]);
      // basic + contradiction 同为最高优先级，但整体仍按 priority 降序排列在前四位。
      expect(result.slice(0, 4).map((s) => s.category).sort()).toEqual(["basic", "basic", "contradiction", "contradiction"]);
    });

    it("caps contradiction questions at 3 even with more high-confidence contradictions", async () => {
      await writeContradictions([
        contradiction("ct-1", "A", "属性", 0.9),
        contradiction("ct-2", "B", "属性", 0.9),
        contradiction("ct-3", "C", "属性", 0.9),
        contradiction("ct-4", "D", "属性", 0.9),
      ]);
      const result = await suggestions.suggestQuestions(OPERATOR, caseId);
      expect(result.filter((s) => s.category === "contradiction")).toHaveLength(3);
    });

    it("ignores contradictions at or below the 0.7 confidence threshold", async () => {
      await writeContradictions([contradiction("ct-1", "甲船", "位置", 0.7)]);
      const result = await suggestions.suggestQuestions(OPERATOR, caseId);
      expect(result.some((s) => s.category === "contradiction")).toBe(false);
    });

    it("adds a timeline question spanning first-to-last anchored time element once >=3 time elements exist", async () => {
      await writeElements([
        el("t1", "2026年5月1日", "time", ["h1"]),
        el("t2", "2026年6月1日", "time", ["h2"]),
        el("t3", "2026年7月1日", "time", ["h3"]),
        el("p1", "甲", "person", ["h1"]),
      ]);
      const result = await suggestions.suggestQuestions(OPERATOR, caseId);
      const timelineQs = result.filter((s) => s.category === "timeline");
      expect(timelineQs).toHaveLength(1);
      expect(timelineQs[0]!.question).toBe("从2026年5月1日到2026年7月1日，发生了什么？");
    });

    it("does not add a timeline question with fewer than 3 time elements", async () => {
      await writeElements([el("t1", "2026年5月1日", "time", ["h1"]), el("t2", "2026年6月1日", "time", ["h2"])]);
      const result = await suggestions.suggestQuestions(OPERATOR, caseId);
      expect(result.some((s) => s.category === "timeline")).toBe(false);
    });

    it("adds relationship questions from the top co-occurring element pairs, capped at 3", async () => {
      await writeElements([
        el("a", "甲", "person", ["h1"]),
        el("b", "乙", "org", ["h1"]),
      ]);
      const result = await suggestions.suggestQuestions(OPERATOR, caseId);
      const relationshipQs = result.filter((s) => s.category === "relationship");
      expect(relationshipQs).toHaveLength(1);
      expect(relationshipQs[0]!.question).toBe("甲与乙是什么关系？");
      expect(relationshipQs[0]!.rationale).toContain("1 处素材片段");
    });

    it("caps the overall list at 8 suggestions", async () => {
      await writeContradictions([
        contradiction("ct-1", "A", "属性", 0.9),
        contradiction("ct-2", "B", "属性", 0.9),
        contradiction("ct-3", "C", "属性", 0.9),
      ]);
      await writeElements([
        el("t1", "2026年5月1日", "time", ["h1"]),
        el("t2", "2026年6月1日", "time", ["h2"]),
        el("t3", "2026年7月1日", "time", ["h3"]),
        el("p1", "甲", "person", ["h1"]),
        el("p2", "乙", "org", ["h1"]),
        el("p3", "丙", "location", ["h2"]),
        el("p4", "丁", "equipment", ["h2"]),
      ]);
      const result = await suggestions.suggestQuestions(OPERATOR, caseId);
      expect(result.length).toBeLessThanOrEqual(8);
    });

    it("records a suggestion.questions audit entry", async () => {
      await suggestions.suggestQuestions(OPERATOR, caseId);
      const events = await audit.readCaseEvents(caseId);
      expect(events.some((e) => e.action === "suggestion.questions" && e.result === "ok")).toBe(true);
    });
  });

  describe("suggestQuestionsWithLLM", () => {
    function scriptedAdapter(content: () => string): ModelAdapter {
      return {
        name: "scripted",
        async generate() {
          return { message: { role: "assistant", content: content() }, stopReason: "end_turn" };
        },
      };
    }

    function withLLM(adapter: ModelAdapter): SuggestionService {
      const guard = new OfflineGuard(["stub.local"], audit);
      return new SuggestionService(audit, inquiries, findings, contradictions, elementGraph, context, promptService, {
        adapter,
        guard,
        modelEndpoint: "https://stub.local/v1",
      });
    }

    it("falls back to pure rule-based suggestions when LLM adapter is not configured", async () => {
      const ruleBased = await suggestions.suggestQuestions(OPERATOR, caseId);
      const result = await suggestions.suggestQuestionsWithLLM(OPERATOR, caseId);
      expect(result).toEqual(ruleBased);
      expect(result.some((s) => s.category === "analysis")).toBe(false);
    });

    it("merges LLM-generated open questions with rule-based ones, capped at 8", async () => {
      const withLlm = withLLM(
        scriptedAdapter(() =>
          JSON.stringify({
            questions: [
              { question: "甲组织与乙组织为何频繁接触？", rationale: "涉及动机分析" },
              { question: "此次行动的资金链条如何形成？", rationale: "涉及因果分析" },
            ],
          }),
        ),
      );

      const result = await withLlm.suggestQuestionsWithLLM(OPERATOR, caseId);

      expect(result.length).toBeLessThanOrEqual(8);
      const analysisQs = result.filter((s) => s.category === "analysis");
      expect(analysisQs.map((s) => s.question)).toEqual(["甲组织与乙组织为何频繁接触？", "此次行动的资金链条如何形成？"]);
      expect(analysisQs.every((s) => s.rationale)).toBe(true);
      // 基础问题（priority 5）应排在 LLM 问题（priority 4）之前。
      expect(result.slice(0, 2).every((s) => s.category === "basic")).toBe(true);
    });

    it("deduplicates an LLM question that matches an existing rule-based question (normalized, ignoring trailing punctuation)", async () => {
      const withLlm = withLLM(
        scriptedAdapter(() =>
          JSON.stringify({ questions: [{ question: "这些材料中涉及哪些关键人物?", rationale: "与基础问题重复" }] }),
        ),
      );

      const result = await withLlm.suggestQuestionsWithLLM(OPERATOR, caseId);
      expect(result.filter((s) => s.question.startsWith("这些材料中涉及哪些关键人物"))).toHaveLength(1);
    });

    it("respects the maxQuestions option", async () => {
      // 制造 4 条以上规则建议（2 基础 + 3 矛盾派生）+ 1 条 LLM 建议，验证 maxQuestions 生效截断。
      await writeContradictions([
        contradiction("ct-1", "A", "属性", 0.9),
        contradiction("ct-2", "B", "属性", 0.9),
        contradiction("ct-3", "C", "属性", 0.9),
      ]);
      const withLlm = withLLM(
        scriptedAdapter(() => JSON.stringify({ questions: [{ question: "新问题一", rationale: "r1" }] })),
      );
      const unbounded = await withLlm.suggestQuestionsWithLLM(OPERATOR, caseId);
      expect(unbounded.length).toBeGreaterThan(2);

      const result = await withLlm.suggestQuestionsWithLLM(OPERATOR, caseId, { maxQuestions: 2 });
      expect(result).toHaveLength(2);
      // priority 最高的两条（基础问题，均为 5）应被保留。
      expect(result.every((s) => s.category === "basic")).toBe(true);
    });

    it("falls back to rule-based only and records an error audit when the LLM call throws", async () => {
      const failing: ModelAdapter = {
        name: "failing",
        async generate() {
          throw new Error("模型出错");
        },
      };
      const withLlm = withLLM(failing);
      const ruleBased = await suggestions.suggestQuestions(OPERATOR, caseId);

      const result = await withLlm.suggestQuestionsWithLLM(OPERATOR, caseId);
      expect(result).toEqual(ruleBased);

      const events = await audit.readCaseEvents(caseId);
      expect(events.some((e) => e.action === "suggestion.questions.llm" && e.result === "error")).toBe(true);
    });

    it("falls back to rule-based only when the LLM returns unparsable output", async () => {
      const withLlm = withLLM(scriptedAdapter(() => "not json at all"));
      const ruleBased = await suggestions.suggestQuestions(OPERATOR, caseId);

      const result = await withLlm.suggestQuestionsWithLLM(OPERATOR, caseId);
      expect(result).toEqual(ruleBased);
    });

    it("records a suggestion.questions.llm audit entry with the generated count on success", async () => {
      const withLlm = withLLM(
        scriptedAdapter(() => JSON.stringify({ questions: [{ question: "新问题一", rationale: "r1" }] })),
      );
      await withLlm.suggestQuestionsWithLLM(OPERATOR, caseId);

      const events = await audit.readCaseEvents(caseId);
      expect(events.some((e) => e.action === "suggestion.questions.llm" && e.result === "ok" && e.detail?.count === 1)).toBe(true);
    });
  });

  describe("suggestFindings", () => {
    it("suggests a finding from a supported inquiry claim with >=2 fully supported citations", async () => {
      const cite1 = await validCitation("目标甲在码头出现。");
      const cite2 = await validCitation("目标甲进入仓库。");
      const supported = claim("目标甲在码头出现。", { citations: [cite1, cite2] });
      const tooFewCitations = claim("目标乙在附近活动。", { citations: [await validCitation("目标乙在附近活动。")] });
      const unverified = claim("推测目标丙也在场。", { support_status: "support-unverified", citations: [await validCitation("目标丙其一。"), await validCitation("目标丙其二。")] });
      await writeInquiries([inquiry("q1", [supported, tooFewCitations, unverified])]);

      const result = await suggestions.suggestFindings(OPERATOR, caseId);
      const fromInquiry = result.filter((s) => s.source === "inquiry");
      expect(fromInquiry).toHaveLength(1);
      expect(fromInquiry[0]).toMatchObject({ conclusion: "目标甲在码头出现。", autoGenerated: true });
      expect(fromInquiry[0]!.supporting_citations).toHaveLength(2);
      expect(fromInquiry[0]!.supporting_citations.every((citation) => citation.support_status === "supported")).toBe(true);
      expect(fromInquiry[0]!.reasoning).toContain("补充核验");
      expect(fromInquiry[0]!.reasoning).toContain("均已通过");
      expect(typeof fromInquiry[0]!.id).toBe("string");
    });

    it("does not suggest a stale supported claim when any citation is not supported", async () => {
      const cite1 = await validCitation("目标甲在码头出现。");
      const cite2 = await validCitation("目标甲进入仓库。");
      const unsupportedCitation = { ...cite("h-ignored"), support_status: "unsupported" as const };
      await writeInquiries([inquiry("q1", [claim("目标甲在码头出现。", { citations: [cite1, unsupportedCitation, cite2] })])]);

      const result = await suggestions.suggestFindings(OPERATOR, caseId);

      expect(result.some((s) => s.source === "inquiry")).toBe(false);
    });

    it("does not suggest a normal inquiry claim when any citation contradicts it", async () => {
      const cite1 = await validCitation("目标甲在码头出现。");
      const cite2 = await validCitation("目标甲进入仓库。");
      const contradictory = { ...await validCitation("目标甲并未进入码头。"), support_status: "unsupported" as const, support_label: "contradicts" as const };
      await writeInquiries([inquiry("q1", [claim("目标甲在码头出现。", { citations: [cite1, cite2, contradictory] })])]);

      const result = await suggestions.suggestFindings(OPERATOR, caseId);

      expect(result.some((s) => s.source === "inquiry")).toBe(false);
    });

    it("does not re-suggest a claim whose text already exists as a Finding conclusion", async () => {
      const cited = await validCitation("目标甲在码头出现。");
      await findings.create(OPERATOR, caseId, { conclusion: "目标甲在码头出现。", supporting_citations: [cited], confidence: 0.9 });
      await writeInquiries([inquiry("q1", [claim("目标甲在码头出现。", { citations: [cite("h1"), cite("h2")] })])]);

      const result = await suggestions.suggestFindings(OPERATOR, caseId);
      expect(result.some((s) => s.source === "inquiry")).toBe(false);
    });

    it("suggests a finding from a contradiction only once acknowledged (and not dismissed)", async () => {
      const item = contradiction("ct-1", "甲船", "位置", 0.85);
      item.claim_a.citation = await validCitation("甲船位置为甲。");
      item.claim_b.citation = await validCitation("甲船位置为乙。");
      await writeContradictions([item]);

      const beforeAck = await suggestions.suggestFindings(OPERATOR, caseId);
      expect(beforeAck.some((s) => s.source === "contradiction")).toBe(false);

      await contradictions.acknowledge(SECURITY, caseId, "ct-1", { status: "resolved", note: "已核实以甲说法为准" });
      const afterAck = await suggestions.suggestFindings(OPERATOR, caseId);
      const fromContradiction = afterAck.filter((s) => s.source === "contradiction");
      expect(fromContradiction).toHaveLength(1);
      expect(fromContradiction[0]!.supporting_citations).toEqual([expect.objectContaining({ quote: "甲船位置为甲。" })]);
      expect(fromContradiction[0]!.opposing_citations).toEqual([expect.objectContaining({ quote: "甲船位置为乙。" })]);
      expect(fromContradiction[0]!.confidence).toBe(0.85);

      await contradictions.acknowledge(SECURITY, caseId, "ct-1", { status: "dismissed", note: "人工判断非矛盾" });
      const afterDismiss = await suggestions.suggestFindings(OPERATOR, caseId);
      expect(afterDismiss.some((s) => s.source === "contradiction")).toBe(false);
    });

    it("suggests a finding from a timeline element cited >=3 times", async () => {
      await writeElements([
        { ...el("t1", "2026年6月1日", "time", []), mentions: [await validCitation("时间线证据一。"), await validCitation("时间线证据二。"), await validCitation("时间线证据三。")], freq: 3 },
        { ...el("p1", "甲", "person", []), mentions: [await validCitation("甲关联证据。")], freq: 1 },
      ]);
      const result = await suggestions.suggestFindings(OPERATOR, caseId);
      const fromTimeline = result.filter((s) => s.source === "element-timeline");
      expect(fromTimeline).toHaveLength(1);
      expect(fromTimeline[0]!.conclusion).toBe("2026年6月1日存在多条素材记录。");
      expect(fromTimeline[0]!.supporting_citations).toHaveLength(3);
    });

    it("does not suggest a timeline finding for an element cited fewer than 3 times", async () => {
      await writeElements([el("t1", "2026年6月1日", "time", ["h1", "h2"])]);
      const result = await suggestions.suggestFindings(OPERATOR, caseId);
      expect(result.some((s) => s.source === "element-timeline")).toBe(false);
    });

    it("sorts suggestions by confidence descending and records a suggestion.findings audit entry", async () => {
      await writeInquiries([inquiry("q1", [claim("低置信度结论。", { citations: [await validCitation("低置信度证据一。", 0.4), await validCitation("低置信度证据二。", 0.4)] })])]);
      await writeElements([{ ...el("t1", "2026年6月1日", "time", []), mentions: [await validCitation("高置信度证据一。"), await validCitation("高置信度证据二。"), await validCitation("高置信度证据三。")], freq: 3 }]);
      const result = await suggestions.suggestFindings(OPERATOR, caseId);
      expect(result[0]!.confidence).toBeGreaterThanOrEqual(result[result.length - 1]!.confidence);

      const events = await audit.readCaseEvents(caseId);
      expect(events.some((e) => e.action === "suggestion.findings" && e.result === "ok")).toBe(true);
    });

    it("suggests a finding from a structured submit_finding candidate with opposing citations", async () => {
      const supporting = await validCitation("门岗登记车辆 2 辆。");
      const opposing: Citation = { ...(await validCitation("OCR识别车辆 4 辆。")), support_label: "contradicts", support_status: "unsupported" };
      const sf: InquirySubmittedFinding = {
        conclusion: "门岗登记与OCR识别车辆数不一致。",
        supporting_citations: [supporting],
        opposing_citations: [opposing],
        reasoning: "门岗登记 2 辆，OCR 识别 4 辆",
        open_questions: [],
      };
      await writeInquiries([inquiry("q1", [], [sf])]);

      const result = await suggestions.suggestFindings(OPERATOR, caseId);
      const fromStructured = result.filter((s) => s.source === "inquiry-structured");
      expect(fromStructured).toHaveLength(1);
      expect(fromStructured[0]!.conclusion).toBe(sf.conclusion);
      expect(fromStructured[0]!.opposing_citations).toHaveLength(1);
      expect(fromStructured[0]!.reasoning).toContain("门岗登记 2 辆，OCR 识别 4 辆");
    });

    it("prefers the structured suggestion over source-one when both cover the same conclusion text", async () => {
      const conclusion = "门岗登记与OCR识别车辆数不一致。";
      const supportCite1 = await validCitation("门岗登记车辆 2 辆。");
      const supportCite2 = await validCitation("门岗登记车辆确系 2 辆。");
      const opposingCite: Citation = { ...(await validCitation("OCR识别车辆 4 辆。")), support_label: "contradicts", support_status: "unsupported" };
      const normalClaim = claim(conclusion, { citations: [supportCite1, supportCite2] });
      const sf: InquirySubmittedFinding = {
        conclusion,
        supporting_citations: [supportCite1],
        opposing_citations: [opposingCite],
        open_questions: [],
      };
      await writeInquiries([inquiry("q1", [normalClaim], [sf])]);

      const result = await suggestions.suggestFindings(OPERATOR, caseId);
      const matches = result.filter((s) => s.conclusion === conclusion);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.source).toBe("inquiry-structured");
      expect(matches[0]!.opposing_citations).toHaveLength(1);
    });
  });

  describe("generateFindingSuggestions", () => {
    function scriptedAdapter(content: () => string): ModelAdapter {
      return {
        name: "scripted",
        async generate() {
          return { message: { role: "assistant", content: content() }, stopReason: "end_turn" };
        },
      };
    }

    it("does nothing destructive when the text model is not configured", async () => {
      const result = await suggestions.generateFindingSuggestions(OPERATOR, caseId);

      expect(result).toMatchObject({ questions: [], inquiriesCreated: 0, skippedExisting: 0, suggestions: [] });
      const events = await audit.readCaseEvents(caseId);
      expect(events.some((e) => e.action === "suggestion.findings.generate" && e.detail?.reason === "llm-unconfigured")).toBe(true);
    });

    it("runs auto questions through inquiry and returns generated finding candidates", async () => {
      const supporting = [await validCitation("目标甲在码头出现。"), await validCitation("目标甲进入仓库。")];
      const generated: Inquiry[] = [];
      const fakeInquiries = {
        async list() {
          return generated;
        },
        async ask(_actor: Identity, _caseId: string, question: string) {
          const next = inquiry(`auto-${generated.length}`, [claim("目标甲在码头出现。", { citations: supporting })]);
          next.question = question;
          generated.push(next);
          return next;
        },
      } as unknown as InquiryService;
      const withAutoInquiry = new SuggestionService(audit, fakeInquiries, findings, contradictions, elementGraph, context, promptService, {
        adapter: scriptedAdapter(() => JSON.stringify({ questions: [{ question: "目标甲的活动轨迹是否异常？", rationale: "轨迹研判" }] })),
        guard: new OfflineGuard(["stub.local"], audit),
        modelEndpoint: "https://stub.local/v1",
      });

      const result = await withAutoInquiry.generateFindingSuggestions(OPERATOR, caseId);

      expect(result.questions).toContain("目标甲的活动轨迹是否异常？");
      expect(result.inquiriesCreated).toBeGreaterThan(0);
      expect(result.suggestions.some((item) => item.conclusion === "目标甲在码头出现。")).toBe(true);
      const events = await audit.readCaseEvents(caseId);
      expect(events.some((e) => e.action === "suggestion.findings.generate" && e.detail?.inquiriesCreated === result.inquiriesCreated)).toBe(true);
    });
  });

  describe("applyFinding", () => {
    it("creates a real Finding from a server-generated suggestion and records a suggestion.apply audit entry", async () => {
      const text = "目标甲在码头出现。";
      const supportCite = await validCitation(text);
      await writeInquiries([inquiry("q1", [claim(text, { citations: [supportCite, { ...supportCite, confidence: 0.85 }] })])]);
      const [suggestion] = await suggestions.suggestFindings(OPERATOR, caseId);

      const created = await suggestions.applyFinding(OPERATOR, caseId, suggestion!.id);
      expect(created).toMatchObject({ conclusion: suggestion.conclusion, review_status: "draft" });
      expect(created.confidence).toBeCloseTo(0.875, 5);
      expect(await findings.list(OPERATOR, caseId)).toEqual([created]);

      const events = await audit.readCaseEvents(caseId);
      expect(events.some((e) => e.action === "suggestion.apply" && e.detail?.findingId === created.id && e.detail?.source === "inquiry")).toBe(true);
    });

    it("rejects an unknown or stale suggestion id", async () => {
      await expect(suggestions.applyFinding(OPERATOR, caseId, "sug-missing")).rejects.toMatchObject({ status: 404 });
    });
  });

  /** 真实摄入一份文本素材，返回其中一段文字对应的、可通过引用完整性校验的 Citation（供 applyFinding 落盘用）。 */
  async function validCitation(text: string, confidence = 0.9): Promise<Citation> {
    await materials.ingest(OPERATOR, caseId, [{ filename: "intel.txt", content: `前情。${text}后续。` }]);
    const chunk = (await materials.loadCaseChunks(caseId)).find((item) => item.text.includes(text))!;
    return { ...chunkToCitation(chunk, "intel.txt", confidence, text), support_status: "supported" };
  }
});
