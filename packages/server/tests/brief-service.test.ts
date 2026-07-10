import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ModelAdapter } from "mini-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContradictionService } from "../src/analysis/contradiction-service.js";
import { ElementGraphService } from "../src/analysis/element-graph-service.js";
import { AuditService } from "../src/audit/audit-service.js";
import { BriefService } from "../src/brief/brief-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Chunk, Citation, Contradiction, ContradictionDetectionResult, Element, Finding, Identity } from "../src/domain/types.js";
import { ElementService } from "../src/elements/element-service.js";
import { FindingService } from "../src/finding/finding-service.js";
import { MaterialService } from "../src/materials/material-service.js";
import type { LlmDeps } from "../src/model/structured.js";
import { OfflineGuard } from "../src/security/offline-guard.js";
import type { QuestionSuggestion } from "../src/suggestion/suggestion-service.js";
import { TaskService } from "../src/task/task-service.js";

/**
 * BriefService 测试（阶段三 M2 / D1·D5）。聚合部分只读落盘产物，用 fixture 直写
 * elements.json / contradictions.result.json / findings.json 驱动；概览段用脚本化
 * ModelAdapter 模拟 LLM，不出真实网络。核心校验：概览逐句 quote 校验丢弃不过关句、
 * 降级态、指纹命中/失配重算、密级拒绝。
 */

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const TOPSECRET: Identity = { id: "boss", name: "boss", role: "operator", clearance: "topsecret" };

const stubSuggestions = {
  suggestQuestions: async (): Promise<QuestionSuggestion[]> => [
    { category: "basic", question: "这些材料涉及哪些关键人物？", rationale: "梳理人物", priority: 5 },
  ],
};

/** 默认无自动研判进度（未跑过批处理）；需要时各用例可覆写。 */
const stubAutoInquiry = {
  getProgress: async () => null,
};

function scriptedAdapter(content: () => string, calls?: { n: number }): ModelAdapter {
  return {
    name: "scripted",
    async generate() {
      if (calls) calls.n += 1;
      return { message: { role: "assistant", content: content() }, stopReason: "end_turn" };
    },
  };
}

describe("BriefService（阶段三 M2 研判简报聚合）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let materials: MaterialService;
  let elements: ElementService;
  let elementGraph: ElementGraphService;
  let contradictions: ContradictionService;
  let findings: FindingService;
  let tasks: TaskService;
  let caseId: string;
  let chunk: Chunk;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-brief-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    materials = new MaterialService(paths, audit, cases);
    const baseLlm: LlmDeps = { adapter: null, guard: new OfflineGuard([], audit), modelEndpoint: "" };
    elements = new ElementService(paths, audit, cases, materials, baseLlm);
    findings = new FindingService(paths, audit, cases);
    elementGraph = new ElementGraphService(elements);
    contradictions = new ContradictionService(paths, audit, cases, materials, baseLlm);
    tasks = new TaskService(paths, audit, cases);

    caseId = (await cases.create(OPERATOR, { name: "简报专题", clearance: "internal" })).id;
    await materials.ingest(OPERATOR, caseId, [{ filename: "intel.txt", content: "目标甲于码头出现。随后驶离港口。" }]);
    chunk = (await materials.loadCaseChunks(caseId))[0]!;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeCaseJson(file: string, value: unknown): Promise<void> {
    const target = path.join(paths.caseDir(caseId), file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  function cite(hash: string): Citation {
    return { material_id: chunk.material_id, material_name: "intel.txt", modality: "doc", locator: { paragraph: 1 }, snippet: "线索", confidence: 0.8, content_hash: hash };
  }

  async function seedProducts(): Promise<void> {
    const els: Element[] = [
      { id: "el-time", type: "time", name: "2026年3月1日", aliases: [], mentions: [cite(chunk.content_hash)], freq: 3 },
      { id: "el-person", type: "person", name: "目标甲", aliases: [], mentions: [cite(chunk.content_hash)], freq: 5 },
    ];
    await writeCaseJson("elements.json", els);

    const contradiction: Contradiction = {
      id: "ct-1",
      entity: "目标甲",
      attribute: "位置",
      scope: "cross-material",
      claim_a: { text: "在码头", citation: cite(chunk.content_hash) },
      claim_b: { text: "在港外", citation: cite(chunk.content_hash) },
      relation: "contradiction",
      rationale: "位置冲突",
      confidence: 0.9,
    };
    const result: ContradictionDetectionResult = {
      status: "succeeded",
      contradictions: [contradiction],
      groundedPropositions: [],
      processedChunks: 1,
      totalChunks: 1,
      truncated: false,
      warnings: [],
    };
    await writeCaseJson("contradictions.result.json", result);

    const finding = (id: string, status: Finding["review_status"]): Finding => ({
      id,
      caseId,
      conclusion: `结论${id}`,
      supporting_citations: [cite(chunk.content_hash)],
      opposing_citations: [],
      confidence: 0.8,
      review_status: status,
      open_questions: [],
    });
    await writeCaseJson("findings.json", [finding("f1", "approved"), finding("f2", "draft")]);
  }

  function makeBrief(content: () => string, calls?: { n: number }, adapterNull = false, customAdapter?: ModelAdapter): BriefService {
    const guard = new OfflineGuard(["stub.local"], audit);
    const llm: LlmDeps = { adapter: adapterNull ? null : (customAdapter ?? scriptedAdapter(content, calls)), guard, modelEndpoint: adapterNull ? "" : "https://stub.local/v1" };
    return new BriefService(paths, audit, cases, materials, elements, elementGraph, contradictions, findings, tasks, stubSuggestions, stubAutoInquiry, llm);
  }

  it("聚合六板块数据面：概览+统计+时间线+实体+未处置矛盾+待核问题", async () => {
    await seedProducts();
    const validQuote = chunk.text.slice(0, 6);
    const brief = await makeBrief(() => JSON.stringify({ sentences: [{ text: "目标甲在码头出现。", chunk_id: chunk.chunk_id, quote: validQuote }] })).getBrief(OPERATOR, caseId);

    expect(brief.degraded).toBe(false);
    expect(brief.overview).toHaveLength(1);
    expect(brief.overview[0]).toMatchObject({ text: "目标甲在码头出现。", chunk_id: chunk.chunk_id, quote: validQuote, material_id: chunk.material_id });
    expect(brief.overview[0].citation.quote).toBe(validQuote);

    expect(brief.materials).toMatchObject({ total: 1, done: 1 });
    expect(brief.materials.byModality.doc).toBe(1);
    expect(brief.processing).toMatchObject({ elementCount: 2, contradictionCount: 1, unresolvedContradictionCount: 1, findingCount: 2, approvedFindingCount: 1 });

    expect(brief.timeline.length).toBeGreaterThanOrEqual(1);
    expect(brief.timeline[0].label).toBe("2026年3月1日");
    expect(brief.entities.map((e) => e.name)).toEqual(["目标甲", "2026年3月1日"]);
    expect(brief.contradictions).toHaveLength(1);
    expect(brief.contradictions[0]).toMatchObject({ id: "ct-1", acknowledgement_status: null });
    expect(brief.openQuestions).toHaveLength(1);

    expect(brief.autopilot).toBe(true);
    // 覆盖度点亮（阶段三 M4）：本 fixture 满足背景+结论 2 节，时间线/矛盾/未决事项 3 节缺口。
    expect(brief.coverage).toMatchObject({ satisfiedCount: 2, totalSections: 5 });
    expect(brief.coverage.sections.map((s) => s.satisfied)).toEqual([true, false, false, true, false]);
    expect(brief.task).toBeNull();
  });

  it("概览逐句校验：丢弃编造引文、坏 chunk_id 与空引文，仅保留可回溯句", async () => {
    const content = JSON.stringify({
      sentences: [
        { text: "有效句", chunk_id: chunk.chunk_id, quote: chunk.text.slice(0, 5) },
        { text: "编造引文", chunk_id: chunk.chunk_id, quote: "绝不存在于原文的文字XYZ" },
        { text: "坏chunk", chunk_id: "nope-999", quote: "任意" },
        { text: "空引文", chunk_id: chunk.chunk_id, quote: "" },
      ],
    });
    const brief = await makeBrief(() => content).getBrief(OPERATOR, caseId);
    expect(brief.overview).toHaveLength(1);
    expect(brief.overview[0].text).toBe("有效句");
  });

  it("LLM 未配置 → 降级为纯统计简报（概览为空、degraded=true，统计仍在）", async () => {
    await seedProducts();
    const brief = await makeBrief(() => "", undefined, true).getBrief(OPERATOR, caseId);
    expect(brief.degraded).toBe(true);
    expect(brief.overview).toHaveLength(0);
    expect(brief.materials.total).toBe(1);
    expect(brief.processing.elementCount).toBe(2);
  });

  it("指纹命中即用缓存；产物变更或 refresh 才重算（LLM 只在重算时调用）", async () => {
    await seedProducts();
    const calls = { n: 0 };
    const brief = makeBrief(() => JSON.stringify({ sentences: [{ text: "句", chunk_id: chunk.chunk_id, quote: chunk.text.slice(0, 4) }] }), calls);

    const first = await brief.getBrief(OPERATOR, caseId);
    expect(calls.n).toBe(1);
    const second = await brief.getBrief(OPERATOR, caseId); // 无变更 → 命中缓存
    expect(calls.n).toBe(1);
    expect(second.generatedAt).toBe(first.generatedAt);

    // 要素产物变更 → 指纹失配 → 重算。
    await writeCaseJson("elements.json", [
      { id: "el-time", type: "time", name: "2026年3月1日", aliases: [], mentions: [cite(chunk.content_hash)], freq: 3 },
      { id: "el-person", type: "person", name: "目标甲", aliases: [], mentions: [cite(chunk.content_hash)], freq: 5 },
      { id: "el-org", type: "org", name: "某组织", aliases: [], mentions: [cite(chunk.content_hash)], freq: 2 },
    ]);
    await brief.getBrief(OPERATOR, caseId);
    expect(calls.n).toBe(2);

    // refresh 强制重算，即使指纹未变。
    await brief.getBrief(OPERATOR, caseId, { refresh: true });
    expect(calls.n).toBe(3);
  });

  it("同 caseId + fingerprint 的并发请求只调用一次模型", async () => {
    const calls = { n: 0 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const adapter: ModelAdapter = {
      name: "slow-scripted",
      async generate() {
        calls.n += 1;
        await gate;
        return {
          message: { role: "assistant", content: JSON.stringify({ sentences: [{ text: "句", chunk_id: chunk.chunk_id, quote: chunk.text.slice(0, 4) }] }) },
          stopReason: "end_turn",
        };
      },
    };
    const brief = makeBrief(() => "", undefined, false, adapter);

    const first = brief.getBrief(OPERATOR, caseId);
    const second = brief.getBrief(OPERATOR, caseId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.n).toBe(1);
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.generatedAt).toBe(b.generatedAt);
    expect(a.overview).toHaveLength(1);
  });

  it("暂态模型降级不覆盖 last-good 缓存，并记录 lastError", async () => {
    let fail = false;
    const calls = { n: 0 };
    const adapter: ModelAdapter = {
      name: "flaky-scripted",
      async generate() {
        calls.n += 1;
        if (fail) throw new Error("Run aborted by signal");
        return {
          message: { role: "assistant", content: JSON.stringify({ sentences: [{ text: "稳定概览", chunk_id: chunk.chunk_id, quote: chunk.text.slice(0, 4) }] }) },
          stopReason: "end_turn",
        };
      },
    };
    const brief = makeBrief(() => "", undefined, false, adapter);
    const good = await brief.getBrief(OPERATOR, caseId);
    fail = true;

    const degraded = await brief.getBrief(OPERATOR, caseId, { refresh: true });

    expect(degraded.degraded).toBe(true);
    expect(degraded.overview).toEqual([]);
    expect(degraded.lastError).toContain("Run aborted by signal");
    const onDisk = JSON.parse(await readFile(path.join(paths.caseDir(caseId), "brief.json"), "utf8")) as { degraded: boolean; overview: unknown[] };
    expect(onDisk.degraded).toBe(false);
    expect(onDisk.overview).toHaveLength(1);
    const cached = await brief.getBrief(OPERATOR, caseId);
    expect(cached.generatedAt).toBe(good.generatedAt);
    expect(cached.overview).toHaveLength(1);
    expect(calls.n).toBe(2);
  });

  it("密级不足 → getBrief 拒绝（复用 cases.get 访问闸门）", async () => {
    const secretCase = (await cases.create(TOPSECRET, { name: "涉密专题", clearance: "secret" })).id;
    const brief = makeBrief(() => JSON.stringify({ sentences: [] }));
    await expect(brief.getBrief(OPERATOR, secretCase)).rejects.toThrow();
  });
});
