import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { GenerateInput, GenerateResult, ModelAdapter } from "mini-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContradictionService } from "../src/analysis/contradiction-service.js";
import { ElementGraphService } from "../src/analysis/element-graph-service.js";
import { PromptStore } from "../src/admin/prompt-store.js";
import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { ContextService } from "../src/context/context-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Identity, Inquiry } from "../src/domain/types.js";
import { ElementService } from "../src/elements/element-service.js";
import { FindingService } from "../src/finding/finding-service.js";
import { AutoInquiryService } from "../src/inquiry/auto-inquiry-service.js";
import { InquiryService } from "../src/inquiry/inquiry-service.js";
import { MaterialService } from "../src/materials/material-service.js";
import { PromptService } from "../src/prompt/prompt-service.js";
import { OfflineGuard } from "../src/security/offline-guard.js";
import { SuggestionService, type QuestionSuggestion } from "../src/suggestion/suggestion-service.js";

/**
 * AutoInquiryService 测试（阶段三 M3 / 计划 D3）。
 * 出题用脚本化的 suggestions（`suggestQuestionsWithLLM` 存根）驱动，问答用脚本化 ModelAdapter
 * 或存根 InquiryService。集成用例用真实 agent 管线（脚本化模型）验证「出题 → 批跑 → 候选入池」全链路。
 */

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const ENDPOINT = "https://stub.local/v1";

function jobCtx(signal: AbortSignal): { signal: AbortSignal; setProgress: (p: unknown) => void } {
  return { signal, setProgress: () => {} };
}

/** 存根 suggestions：把给定问题当作 analysis 类返回（AutoInquiryService 会过滤 basic）。 */
function stubSuggestions(questions: string[]): Pick<SuggestionService, "suggestQuestionsWithLLM"> {
  return {
    suggestQuestionsWithLLM: async (): Promise<QuestionSuggestion[]> =>
      questions.map((question) => ({ category: "analysis", question, rationale: "测试", priority: 4 })),
  };
}

function answered(question: string): Inquiry {
  return { id: `q-${question}`, ts: new Date().toISOString(), user: OPERATOR.id, question, status: "answered", answer: "", claims: [] };
}

describe("AutoInquiryService（阶段三 M3 自动研判批处理）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let caseId: string;
  let savedMax: string | undefined;

  beforeEach(async () => {
    savedMax = process.env.MINI_AGENT_AUTO_INQUIRY_MAX;
    root = await mkdtemp(path.join(tmpdir(), "iw-auto-inq-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    const cases = new CaseService(paths, audit, false);
    caseId = (await cases.create(OPERATOR, { name: "自动研判专题", clearance: "internal" })).id;
  });

  afterEach(async () => {
    if (savedMax === undefined) delete process.env.MINI_AGENT_AUTO_INQUIRY_MAX;
    else process.env.MINI_AGENT_AUTO_INQUIRY_MAX = savedMax;
    await rm(root, { recursive: true, force: true });
  });

  it("默认上限 8：多于上限的问题只跑前 8 题", async () => {
    delete process.env.MINI_AGENT_AUTO_INQUIRY_MAX;
    const questions = Array.from({ length: 10 }, (_, i) => `问题${i}？`);
    const asked: string[] = [];
    const inquiries = {
      list: async () => [],
      ask: async (_a: Identity, _c: string, q: string) => {
        asked.push(q);
        return answered(q);
      },
    };
    const auto = new AutoInquiryService(paths, audit, stubSuggestions(questions), inquiries);

    const progress = await auto.run(OPERATOR, caseId, jobCtx(new AbortController().signal));

    expect(asked).toHaveLength(8);
    expect(progress.total).toBe(8);
    expect(progress.status).toBe("done");
    expect(progress.completed).toBe(8);
  });

  it("MINI_AGENT_AUTO_INQUIRY_MAX 可调整上限", async () => {
    process.env.MINI_AGENT_AUTO_INQUIRY_MAX = "2";
    const questions = ["甲？", "乙？", "丙？", "丁？"];
    const asked: string[] = [];
    const inquiries = {
      list: async () => [],
      ask: async (_a: Identity, _c: string, q: string) => {
        asked.push(q);
        return answered(q);
      },
    };
    const auto = new AutoInquiryService(paths, audit, stubSuggestions(questions), inquiries);

    const progress = await auto.run(OPERATOR, caseId, jobCtx(new AbortController().signal));

    expect(asked).toEqual(["甲？", "乙？"]);
    expect(progress.total).toBe(2);
  });

  it("去重已问过的问题（brief/问答已列出的相同题不再重问）", async () => {
    const asked: string[] = [];
    const inquiries = {
      list: async () => [answered("甲？")], // 甲 已问过
      ask: async (_a: Identity, _c: string, q: string) => {
        asked.push(q);
        return answered(q);
      },
    };
    const auto = new AutoInquiryService(paths, audit, stubSuggestions(["甲?", "乙？"]), inquiries);

    await auto.run(OPERATOR, caseId, jobCtx(new AbortController().signal));

    expect(asked).toEqual(["乙？"]); // 甲（归一化去尾标点后）与已问过重复 → 跳过
  });

  it("单题重试两次仍失败后继续下一题，并把批次标为 failed", async () => {
    const asked: string[] = [];
    const inquiries = {
      list: async () => [],
      ask: async (_a: Identity, _c: string, q: string) => {
        asked.push(q);
        if (q === "乙？") throw new Error("模型不可达");
        return answered(q);
      },
    };
    const auto = new AutoInquiryService(paths, audit, stubSuggestions(["甲？", "乙？", "丙？"]), inquiries);

    await expect(auto.run(OPERATOR, caseId, jobCtx(new AbortController().signal))).rejects.toMatchObject({
      result: { status: "failed", items: [{ status: "done" }, { status: "failed", error: "模型不可达" }, { status: "done" }] },
    });
    expect(asked).toEqual(["甲？", "乙？", "乙？", "乙？", "丙？"]); // 失败题重试后仍继续
    const failEvent = (await audit.readCaseEvents(caseId)).find((e) => e.action === "auto-inquiry.question" && e.result === "error");
    expect(failEvent?.detail).toMatchObject({ index: 1, reason: "模型不可达" });
  });

  it("瞬时失败可在自动重试中恢复", async () => {
    let attempts = 0;
    const inquiries = {
      list: async () => [],
      ask: async (_a: Identity, _c: string, q: string) => {
        attempts += 1;
        if (attempts < 3) throw new Error("temporary");
        return answered(q);
      },
    };
    const auto = new AutoInquiryService(paths, audit, stubSuggestions(["甲？"]), inquiries);

    const progress = await auto.run(OPERATOR, caseId, jobCtx(new AbortController().signal));

    expect(attempts).toBe(3);
    expect(progress).toMatchObject({ status: "done", items: [{ status: "done", attempts: 3 }] });
  });

  it("取消中止批次：AbortSignal 贯通到 ask，剩余题不再跑", async () => {
    const controller = new AbortController();
    const asked: string[] = [];
    let sawSignal = false;
    const inquiries = {
      list: async () => [],
      ask: async (_a: Identity, _c: string, q: string, opts?: { signal?: AbortSignal }) => {
        asked.push(q);
        if (opts?.signal === controller.signal) sawSignal = true;
        controller.abort(); // 第一题运行中取消
        return answered(q);
      },
    };
    const auto = new AutoInquiryService(paths, audit, stubSuggestions(["甲？", "乙？", "丙？"]), inquiries);

    const progress = await auto.run(OPERATOR, caseId, jobCtx(controller.signal));

    expect(sawSignal).toBe(true); // 信号确实透传到 ask
    expect(asked).toEqual(["甲？"]); // 取消后剩余题不再跑
    expect(progress.status).toBe("cancelled");
    expect(progress.items[1]!.status).toBe("pending");
  });

  it("空题集（无可跑问题）→ 批次直接完成，进度落盘可查", async () => {
    const inquiries = { list: async () => [], ask: async () => answered("x") };
    const auto = new AutoInquiryService(paths, audit, stubSuggestions([]), inquiries);

    const progress = await auto.run(OPERATOR, caseId, jobCtx(new AbortController().signal));

    expect(progress).toMatchObject({ status: "done", total: 0, items: [] });
    const persisted = await auto.getProgress(caseId);
    expect(persisted).toMatchObject({ status: "done", total: 0 });
  });

  it("集成：出题 → 批跑 → 结构化候选入池（脚本化模型模式）", async () => {
    const saved = process.env.MINI_AGENT_INQUIRY_MODE;
    process.env.MINI_AGENT_INQUIRY_MODE = "agent";
    try {
      const audit2 = new AuditService(paths);
      const cases = new CaseService(paths, audit2, false);
      const materials = new MaterialService(paths, audit2, cases);
      const guard = new OfflineGuard(["stub.local"], audit2);
      const llm = { adapter: new StructuredFindingAdapter(), guard, modelEndpoint: ENDPOINT };
      const inquiries = new InquiryService(paths, audit2, cases, materials, llm, undefined, undefined, {
        agentWorkspaceRoot: path.join(root, ".agent-scratch"),
        runtimeVersion: "test",
        modelName: "scripted-agent",
        providerName: "scripted",
      });
      const findings = new FindingService(paths, audit2, cases);
      const ruleLlm = { adapter: null, guard, modelEndpoint: "" };
      const contradictions = new ContradictionService(paths, audit2, cases, materials, ruleLlm);
      const elements = new ElementService(paths, audit2, cases, materials, ruleLlm);
      const elementGraph = new ElementGraphService(elements);
      const context = new ContextService(cases, materials, elements, contradictions, inquiries, findings);
      const promptService = new PromptService(new PromptStore(paths, audit2), audit2);
      // 规则版 suggestFindings（无 LLM）用于验证候选入池；出题用存根定死问题。
      const suggestionsForPool = new SuggestionService(audit2, inquiries, findings, contradictions, elementGraph, context, promptService, ruleLlm);

      const gateCaseId = (await cases.create(OPERATOR, { name: "门岗核验", clearance: "internal" })).id;
      await materials.ingest(OPERATOR, gateCaseId, [
        { filename: "gate.txt", content: "门岗登记记录车辆 2 辆。OCR 识别记录车辆 4 辆。" },
      ]);

      const auto = new AutoInquiryService(paths, audit2, stubSuggestions(["门岗登记与OCR识别车辆数是否一致？"]), inquiries);
      const progress = await auto.run(OPERATOR, gateCaseId, jobCtx(new AbortController().signal));

      // 该题产生结构化候选。
      expect(progress.items[0]!.status).toBe("candidate");
      expect(progress.items[0]!.candidateCount).toBeGreaterThanOrEqual(1);
      // 问答记录已持久化（含结构化候选）。
      const list = await inquiries.list(OPERATOR, gateCaseId);
      expect(list).toHaveLength(1);
      expect(list[0]!.submitted_findings?.[0]?.supporting_citations[0]?.verdict).toBe("supports");
      // 既有「问答候选 → Finding 候选池」机制入池。
      const pool = await suggestionsForPool.suggestFindings(OPERATOR, gateCaseId);
      const structured = pool.filter((s) => s.source === "inquiry-structured");
      expect(structured).toHaveLength(1);
      expect(structured[0]!.conclusion).toBe("门岗登记与OCR识别车辆数不一致");
      expect(structured[0]!.opposing_citations).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env.MINI_AGENT_INQUIRY_MODE;
      else process.env.MINI_AGENT_INQUIRY_MODE = saved;
    }
  });
});

// ---- 集成用例的脚本化 agent 适配器 ----

function toolCall(name: string, args: Record<string, unknown>, id: string): GenerateResult {
  return { message: { role: "assistant", content: "", toolCalls: [{ id, name, arguments: args }] }, stopReason: "tool_use" };
}

function toolResults(input: GenerateInput, name: string): { ok: boolean; content: string }[] {
  return input.messages
    .filter((message) => message.role === "tool" && message.toolName === name)
    .map((message) => JSON.parse(message.content) as { ok: boolean; content: string });
}

function firstSearchChunkId(input: GenerateInput): string {
  const [search] = toolResults(input, "search_chunks");
  const chunks = JSON.parse(search?.content ?? "[]") as { chunk_id: string }[];
  return chunks[0]?.chunk_id ?? "missing";
}

function citedIds(input: GenerateInput): string[] {
  return toolResults(input, "cite")
    .filter((result) => result.ok)
    .map((result) => (JSON.parse(result.content) as { cite_id?: string }).cite_id)
    .filter((id): id is string => typeof id === "string");
}

/** 定式：search → cite(支持) → cite(对立) → submit_finding → finalize_answer；支持性裁判首条 supports、次条 contradicts。 */
class StructuredFindingAdapter implements ModelAdapter {
  readonly name = "scripted-agent";
  private supportCalls = 0;

  async generate(input: GenerateInput): Promise<GenerateResult> {
    if (input.tools.length === 0) {
      this.supportCalls += 1;
      const label = this.supportCalls === 1 ? "supports" : "contradicts";
      return { message: { role: "assistant", content: JSON.stringify({ label, rationale: "test" }) }, stopReason: "end_turn" };
    }
    const has = (name: string): boolean => toolResults(input, name).length > 0;
    if (!has("search_chunks")) return toolCall("search_chunks", { query: "门岗 车辆", k: 6 }, "s1");
    const chunkId = firstSearchChunkId(input);
    const cites = toolResults(input, "cite").length;
    if (cites === 0) return toolCall("cite", { chunk_id: chunkId, claim: "门岗登记与OCR识别车辆数不一致", quote: "门岗登记记录车辆 2 辆" }, "c1");
    if (cites === 1) return toolCall("cite", { chunk_id: chunkId, claim: "门岗登记与OCR识别车辆数不一致", quote: "OCR 识别记录车辆 4 辆" }, "c2");
    const ids = citedIds(input);
    if (!has("submit_finding")) {
      return toolCall("submit_finding", {
        conclusion: "门岗登记与OCR识别车辆数不一致",
        supporting_cite_ids: [ids[0] ?? "missing"],
        opposing_cite_ids: [ids[1] ?? "missing"],
        reasoning: "门岗登记 2 辆，OCR 识别 4 辆",
        open_questions: [],
      }, "sf");
    }
    if (!has("finalize_answer")) return toolCall("finalize_answer", { claims: [{ text: "门岗登记与OCR识别车辆数不一致", cite_ids: ids }] }, "f");
    return { message: { role: "assistant", content: "" }, stopReason: "end_turn" };
  }
}
