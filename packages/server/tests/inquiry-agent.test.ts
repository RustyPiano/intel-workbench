import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { GenerateInput, GenerateResult, ModelAdapter } from "mini-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Identity, Inquiry, Material } from "../src/domain/types.js";
import { InquiryService } from "../src/inquiry/inquiry-service.js";
import { MaterialService } from "../src/materials/material-service.js";
import { OfflineGuard } from "../src/security/offline-guard.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const ENDPOINT = "https://stub.local/v1";

function toolCall(name: string, args: Record<string, unknown>, id = `call_${name}`): GenerateResult {
  return {
    message: { role: "assistant", content: "", toolCalls: [{ id, name, arguments: args }] },
    stopReason: "tool_use",
  };
}

function final(content = "raw final text must be ignored"): GenerateResult {
  return { message: { role: "assistant", content }, stopReason: "end_turn" };
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

function firstListedMaterialId(input: GenerateInput): string {
  const [list] = toolResults(input, "list_materials");
  const materials = JSON.parse(list?.content ?? "[]") as { material_id: string }[];
  return materials[0]?.material_id ?? "missing-material";
}

function firstWindowChunkId(input: GenerateInput): string {
  const [window] = toolResults(input, "read_material_window");
  const result = JSON.parse(window?.content ?? "{}") as { chunks?: { chunk_id: string }[] };
  return result.chunks?.[0]?.chunk_id ?? "missing-window-chunk";
}

function citedIds(input: GenerateInput): string[] {
  return toolResults(input, "cite")
    .filter((result) => result.ok)
    .map((result) => {
      try {
        return (JSON.parse(result.content) as { cite_id?: string }).cite_id;
      } catch {
        return undefined;
      }
    })
    .filter((id): id is string => typeof id === "string");
}

type DynamicMode = "valid" | "invalid-cite" | "tampered" | "no-finalize" | "budget" | "context-only" | "nli-failure" | "two-spans" | "mixed-claim" | "duplicate-cites" | "window" | "structured-finding" | "structured-finding-unverified" | "tool-args-error" | "add-claim";

class DynamicInquiryAdapter implements ModelAdapter {
  readonly name = "scripted-agent";
  readonly inputs: GenerateInput[] = [];
  readonly supportInputs: GenerateInput[] = [];
  readonly readContents: string[] = [];
  private toolArgsErrorThrown = false;

  constructor(private readonly mode: DynamicMode) {}

  async generate(input: GenerateInput): Promise<GenerateResult> {
    this.inputs.push(input);
    if (input.tools.length === 0) {
      this.supportInputs.push(input);
      if (this.mode === "nli-failure" || (this.mode === "structured-finding-unverified" && this.supportInputs.length === 1)) {
        throw new Error("support verifier failed");
      }
      const label = this.mode === "context-only" || (this.mode === "mixed-claim" && this.supportInputs.length === 2)
        ? "context-only"
        : (this.mode === "structured-finding" || this.mode === "structured-finding-unverified") && this.supportInputs.length === 2
          ? "contradicts"
          : "supports";
      return final(JSON.stringify({ label, rationale: "test support label" }));
    }
    const has = (name: string) => toolResults(input, name).length > 0;

    if (this.mode === "tool-args-error" && !this.toolArgsErrorThrown) {
      this.toolArgsErrorThrown = true;
      throw new Error("Provider returned invalid tool arguments for search_materials");
    }

    const isRepair = input.messages.some((message) => message.role === "user" && message.content.includes("上一轮自然语言结尾只是草稿"));
    if (this.mode === "no-finalize" && !isRepair) {
      if (!has("search_chunks")) return toolCall("search_chunks", { query: "舰船 线索", k: 6 }, `search_${this.inputs.length}`);
      const chunkId = firstSearchChunkId(input);
      if (!has("cite")) return toolCall("cite", { chunk_id: chunkId, claim: "发现舰船线索", quote: "舰船线索" }, `cite_${this.inputs.length}`);
      return final();
    }

    if (this.mode === "window") {
      if (!has("list_materials")) return toolCall("list_materials", {}, "list_materials");
      if (!has("read_material_window")) {
        return toolCall("read_material_window", { material_id: firstListedMaterialId(input), start_chunk: 0, limit: 2 }, "read_window");
      }
      if (!has("cite")) return toolCall("cite", { chunk_id: firstWindowChunkId(input), claim: "发现窗口线索", quote: "窗口线索" }, "cite_window");
      if (!has("finalize_answer")) {
        return toolCall("finalize_answer", { claims: [{ text: "发现窗口线索", cite_ids: [citedIds(input)[0] ?? "missing-cite-id"] }] }, "final_window");
      }
      return final();
    }

    if (!has("search_chunks")) {
      return toolCall("search_chunks", { query: "舰船 线索", k: 6 }, `search_${this.inputs.length}`);
    }

    const chunkId = firstSearchChunkId(input);

    if (this.mode === "budget") {
      const reads = toolResults(input, "read_chunk");
      this.readContents.splice(0, this.readContents.length, ...reads.map((result) => result.content));
      if (reads.length === 0) return toolCall("read_chunk", { chunk_id: chunkId }, "read_first");
      if (!has("cite")) return toolCall("cite", { chunk_id: chunkId, claim: "发现舰船线索", quote: "舰船线索" }, "cite_budget");
      if (reads.length === 1) return toolCall("read_chunk", { chunk_id: chunkId }, "read_exhausted");
      if (!has("finalize_answer")) {
        return toolCall("finalize_answer", { claims: [{ text: "发现舰船线索", cite_ids: [citedIds(input)[0] ?? "missing-cite-id"] }] }, "final_budget");
      }
      return final();
    }

    if (this.mode === "valid" && !has("read_chunk")) {
      return toolCall("read_chunk", { chunk_id: chunkId }, `read_${this.inputs.length}`);
    }

    if (this.mode === "two-spans") {
      if (!has("read_chunk")) return toolCall("read_chunk", { chunk_id: chunkId }, "read_two_spans");
      const cites = toolResults(input, "cite").length;
      if (cites === 0) return toolCall("cite", { chunk_id: chunkId, claim: "发现蓝色货轮", quote: "雷达记录到蓝色货轮" }, "cite_blue");
      if (cites === 1) return toolCall("cite", { chunk_id: chunkId, claim: "发现红色拖船", quote: "港口日志显示红色拖船" }, "cite_red");
      if (!has("finalize_answer")) {
        const ids = citedIds(input);
        return toolCall("finalize_answer", { claims: [
          { text: "发现蓝色货轮", cite_ids: [ids[0] ?? "missing-cite-id-1"] },
          { text: "发现红色拖船", cite_ids: [ids[1] ?? "missing-cite-id-2"] },
        ] }, "final_two_spans");
      }
      return final();
    }

    if (this.mode === "mixed-claim") {
      if (!has("read_chunk")) return toolCall("read_chunk", { chunk_id: chunkId }, "read_mixed_claim");
      const cites = toolResults(input, "cite").length;
      if (cites === 0) return toolCall("cite", { chunk_id: chunkId, claim: "同时发现蓝色货轮和红色拖船", quote: "雷达记录到蓝色货轮" }, "cite_mixed_blue");
      if (cites === 1) return toolCall("cite", { chunk_id: chunkId, claim: "同时发现蓝色货轮和红色拖船", quote: "港口日志显示红色拖船" }, "cite_mixed_red");
      if (!has("finalize_answer")) {
        return toolCall("finalize_answer", { claims: [{ text: "同时发现蓝色货轮和红色拖船", cite_ids: citedIds(input) }] }, "final_mixed_claim");
      }
      return final();
    }

    if (this.mode === "structured-finding" || this.mode === "structured-finding-unverified") {
      if (!has("read_chunk")) return toolCall("read_chunk", { chunk_id: chunkId }, "read_structured_finding");
      const cites = toolResults(input, "cite").length;
      if (cites === 0) return toolCall("cite", { chunk_id: chunkId, claim: "门岗登记与OCR识别车辆数不一致", quote: "门岗登记记录车辆 2 辆" }, "cite_structured_support");
      if (cites === 1) return toolCall("cite", { chunk_id: chunkId, claim: "门岗登记与OCR识别车辆数不一致", quote: "OCR 识别记录车辆 4 辆" }, "cite_structured_oppose");
      const ids = citedIds(input);
      if (!has("submit_finding")) {
        return toolCall("submit_finding", {
          conclusion: "门岗登记与OCR识别车辆数不一致",
          supporting_cite_ids: [ids[0] ?? "missing-cite-id-1"],
          opposing_cite_ids: [ids[1] ?? "missing-cite-id-2"],
          reasoning: "门岗登记 2 辆，OCR 识别 4 辆，需人工复核",
          open_questions: ["是否有漏记车辆"],
        }, "submit_finding_structured");
      }
      if (!has("finalize_answer")) {
        return toolCall("finalize_answer", { claims: [{ text: "门岗登记与OCR识别车辆数不一致", cite_ids: ids }] }, "final_structured_finding");
      }
      return final();
    }

    if (this.mode === "add-claim") {
      // 增量流程：read→cite→add_claim 逐条提交→finalize_answer 无参数封卷。
      if (!has("read_chunk")) return toolCall("read_chunk", { chunk_id: chunkId }, "read_add_claim");
      if (!has("cite")) return toolCall("cite", { chunk_id: chunkId, claim: "发现舰船线索", quote: "舰船线索" }, "cite_add_claim");
      if (!has("add_claim")) return toolCall("add_claim", { text: "发现舰船线索", cite_ids: [citedIds(input)[0] ?? "missing-cite-id"] }, "add_claim_1");
      if (!has("finalize_answer")) return toolCall("finalize_answer", {}, "final_add_claim");
      return final();
    }

    if (!has("cite")) {
      const citeId = this.mode === "invalid-cite" ? "not-returned#999" : chunkId;
      return toolCall("cite", { chunk_id: citeId, claim: "发现舰船线索", quote: "舰船线索" }, `cite_${this.inputs.length}`);
    }

    if (!has("finalize_answer")) {
      const citeId = this.mode === "invalid-cite" ? "not-returned#999" : (citedIds(input)[0] ?? "missing-cite-id");
      const cite_ids = this.mode === "duplicate-cites" ? [citeId, citeId] : [citeId];
      return toolCall("finalize_answer", { claims: [{ text: "发现舰船线索", cite_ids }] }, `final_${this.inputs.length}`);
    }

    return final();
  }
}

interface Fixture {
  root: string;
  paths: DataPaths;
  audit: AuditService;
  cases: CaseService;
  materials: MaterialService;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "iw-inq-agent-"));
  const paths = resolveDataPaths(root);
  const audit = new AuditService(paths);
  const cases = new CaseService(paths, audit, false);
  const materials = new MaterialService(paths, audit, cases);
  return { root, paths, audit, cases, materials };
}

function createService(
  fixture: Fixture,
  adapter: ModelAdapter | null,
  options: {
    allowlist?: string[];
    endpoint?: string;
    readBudgetBytes?: number;
    perReadCapBytes?: number;
    maxTurns?: number;
    skillDirs?: string[];
  } = {},
): InquiryService {
  const guard = new OfflineGuard(options.allowlist ?? ["stub.local"], fixture.audit);
  return new InquiryService(
    fixture.paths,
    fixture.audit,
    fixture.cases,
    fixture.materials,
    { adapter, guard, modelEndpoint: options.endpoint ?? (adapter ? ENDPOINT : "") },
    undefined,
    undefined,
    {
      agentWorkspaceRoot: path.join(fixture.root, ".agent-scratch"),
      runtimeVersion: "test",
      modelName: "scripted-agent",
      providerName: "scripted",
      maxTurns: options.maxTurns ?? 12,
      readBudgetBytes: options.readBudgetBytes,
      perReadCapBytes: options.perReadCapBytes,
      skillDirs: options.skillDirs,
    },
  );
}

/** 在 root/skills/<name>/SKILL.md 造一个仅含 frontmatter 的技能，返回 skills 目录。 */
async function writeSkillDir(root: string, name: string, description: string): Promise<string> {
  const skillsDir = path.join(root, "skills");
  const skillRoot = path.join(skillsDir, name);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, "utf8");
  return skillsDir;
}

async function createCaseWithDocs(fixture: Fixture, name: string, docs: { filename: string; content: string }[]): Promise<string> {
  const caseId = (await fixture.cases.create(OPERATOR, { name, clearance: "internal" })).id;
  await fixture.materials.ingest(OPERATOR, caseId, docs);
  return caseId;
}

async function tamperFirstChunkHash(fixture: Fixture, caseId: string, material: Material): Promise<void> {
  const file = path.join(fixture.paths.caseDir(caseId), "processed", `${material.id}.chunks.jsonl`);
  const chunks = (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  chunks[0]!.content_hash = "bad-hash";
  await writeFile(file, `${chunks.map((chunk) => JSON.stringify(chunk)).join("\n")}\n`, "utf8");
}

describe.sequential("InquiryService agent harness", () => {
  let savedMode: string | undefined;
  let fixture: Fixture;

  beforeEach(async () => {
    savedMode = process.env.MINI_AGENT_INQUIRY_MODE;
    process.env.MINI_AGENT_INQUIRY_MODE = "agent";
    fixture = await createFixture();
  });

  afterEach(async () => {
    if (savedMode === undefined) delete process.env.MINI_AGENT_INQUIRY_MODE;
    else process.env.MINI_AGENT_INQUIRY_MODE = savedMode;
    await rm(fixture.root, { recursive: true, force: true });
  });

  it("runs multi-turn search/read/cite/finalize and stores only verified finalized claims", async () => {
    const caseId = await createCaseWithDocs(fixture, "agent 多轮", [
      { filename: "intel.txt", content: "舰船线索：南海周边发现可疑舰船活动，疑似军事演习。" },
    ]);
    const adapter = new DynamicInquiryAdapter("valid");

    const inquiry = await createService(fixture, adapter).ask(OPERATOR, caseId, "有何舰船线索");

    expect(inquiry.status).toBe("answered");
    expect(inquiry.answer).toContain("1. 发现舰船线索");
    expect(inquiry.claims[0]?.status).toBe("verified");
    expect(inquiry.claims[0]?.citations[0]?.material_name).toBe("intel.txt");
    expect(inquiry.claims[0]?.citations[0]?.quote).toBe("舰船线索");
    expect(inquiry.claims[0]?.citations[0]?.support_label).toBe("supports");
    expect(inquiry.claims[0]?.support_status).toBe("supported");
    expect(inquiry.claims[0]?.citations[0]?.support_status).toBe("supported");
    expect(adapter.supportInputs[0]?.systemPrompt).toContain("如果 quote 是 claim 所述对比或差异中的一方原始记录");
    expect(inquiry.answer).not.toContain("raw final text");
  });

  it("runs the incremental add_claim flow and seals draft claims on empty finalize", async () => {
    const caseId = await createCaseWithDocs(fixture, "agent 增量", [
      { filename: "intel.txt", content: "舰船线索：南海周边发现可疑舰船活动，疑似军事演习。" },
    ]);
    const adapter = new DynamicInquiryAdapter("add-claim");

    const inquiry = await createService(fixture, adapter).ask(OPERATOR, caseId, "有何舰船线索");

    expect(inquiry.status).toBe("answered");
    expect(inquiry.answer).toContain("1. 发现舰船线索");
    expect(inquiry.claims[0]?.status).toBe("verified");
    expect(inquiry.claims[0]?.citations[0]?.quote).toBe("舰船线索");
    expect(inquiry.claims[0]?.support_status).toBe("supported");
    expect(inquiry.claims[0]?.citations[0]?.support_label).toBe("supports");
  });

  it("keeps two claims on one chunk bound to their own quoted spans", async () => {
    const caseId = await createCaseWithDocs(fixture, "agent 双 span", [
      { filename: "intel.txt", content: "雷达记录到蓝色货轮。港口日志显示红色拖船。" },
    ]);

    const inquiry = await createService(fixture, new DynamicInquiryAdapter("two-spans")).ask(OPERATOR, caseId, "有哪些船只线索");

    expect(inquiry.status).toBe("answered");
    expect(inquiry.claims).toHaveLength(2);
    expect(inquiry.claims[0]?.citations[0]?.quote).toBe("雷达记录到蓝色货轮");
    expect(inquiry.claims[1]?.citations[0]?.quote).toBe("港口日志显示红色拖船");
    expect(inquiry.claims[0]?.citations[0]?.support_label).toBe("supports");
    expect(inquiry.claims[1]?.citations[0]?.support_label).toBe("supports");
    expect(inquiry.claims[0]?.citations[0]?.quote_hash).not.toBe(inquiry.claims[1]?.citations[0]?.quote_hash);
  });

  it("marks a claim support-unverified when any citation is not fully supported", async () => {
    const caseId = await createCaseWithDocs(fixture, "agent mixed support", [
      { filename: "intel.txt", content: "雷达记录到蓝色货轮。港口日志显示红色拖船。" },
    ]);

    const inquiry = await createService(fixture, new DynamicInquiryAdapter("mixed-claim")).ask(OPERATOR, caseId, "有哪些船只线索");

    expect(inquiry.status).toBe("insufficient");
    expect(inquiry.answer).not.toContain("同时发现蓝色货轮和红色拖船");
    expect(inquiry.claims).toHaveLength(1);
    expect(inquiry.claims[0]?.status).toBe("unverified");
    expect(inquiry.claims[0]?.support_status).toBe("support-unverified");
    expect(inquiry.claims[0]?.citations.map((citation) => citation.support_status)).toEqual(["supported", "unsupported"]);
  });

  it("stores a structured submit_finding candidate with verified supporting/opposing citations", async () => {
    const caseId = await createCaseWithDocs(fixture, "agent 结构化研判", [
      { filename: "gate.txt", content: "舰船线索：门岗登记记录车辆 2 辆。OCR 识别记录车辆 4 辆。" },
    ]);

    const inquiry = await createService(fixture, new DynamicInquiryAdapter("structured-finding")).ask(OPERATOR, caseId, "门岗登记与OCR识别是否一致");

    expect(inquiry.submitted_findings).toHaveLength(1);
    expect(inquiry.submitted_findings?.[0]?.supporting_citations[0]?.support_status).toBe("supported");
    expect(inquiry.submitted_findings?.[0]?.opposing_citations[0]?.support_label).toBe("contradicts");
  });

  it("keeps support-unverified evidence in claims but excludes the submitted Finding candidate", async () => {
    const caseId = await createCaseWithDocs(fixture, "agent 未核支持候选", [
      { filename: "gate.txt", content: "舰船线索：门岗登记记录车辆 2 辆。OCR 识别记录车辆 4 辆。" },
    ]);

    const inquiry = await createService(fixture, new DynamicInquiryAdapter("structured-finding-unverified"))
      .ask(OPERATOR, caseId, "门岗登记与OCR识别是否一致");

    expect(inquiry.claims[0]?.support_status).toBe("support-unverified");
    expect(inquiry.submitted_findings).toBeUndefined();
  });

  it("does not count a finalized citation as grounded unless support verification says supports", async () => {
    const caseId = await createCaseWithDocs(fixture, "agent context-only", [
      { filename: "intel.txt", content: "舰船线索：南海周边发现可疑舰船活动，疑似军事演习。" },
    ]);

    const inquiry = await createService(fixture, new DynamicInquiryAdapter("context-only")).ask(OPERATOR, caseId, "有何舰船线索");

    expect(inquiry.status).toBe("insufficient");
    expect(inquiry.claims[0]?.status).toBe("unverified");
    expect(inquiry.claims[0]?.support_status).toBe("unsupported");
    expect(inquiry.claims[0]?.citations[0]?.support_label).toBe("context-only");
    expect(inquiry.claims[0]?.citations[0]?.support_status).toBe("unsupported");
  });

  it("labels NLI failures unknown, returns the inquiry, and audits the failure", async () => {
    const caseId = await createCaseWithDocs(fixture, "agent nli failure", [
      { filename: "intel.txt", content: "舰船线索：南海周边发现可疑舰船活动，疑似军事演习。" },
    ]);

    const inquiry = await createService(fixture, new DynamicInquiryAdapter("nli-failure")).ask(OPERATOR, caseId, "有何舰船线索");

    expect(inquiry.status).toBe("insufficient");
    expect(inquiry.answer).not.toContain("发现舰船线索");
    expect(inquiry.claims[0]?.status).toBe("unverified");
    expect(inquiry.claims[0]?.support_status).toBe("support-unverified");
    expect(inquiry.claims[0]?.citations[0]?.support_label).toBe("unknown");
    expect(inquiry.claims[0]?.citations[0]?.support_status).toBe("support-unverified");
    const events = await fixture.audit.readAll();
    expect(events.some((event) => event.action === "inquiry.support_verify" && event.result === "error")).toBe(true);
  });

  it("dedupes repeated cite_ids before support verification", async () => {
    const caseId = await createCaseWithDocs(fixture, "agent 重复引用", [
      { filename: "intel.txt", content: "舰船线索：南海周边发现可疑舰船活动，疑似军事演习。" },
    ]);
    const adapter = new DynamicInquiryAdapter("duplicate-cites");

    const inquiry = await createService(fixture, adapter).ask(OPERATOR, caseId, "有何舰船线索");

    expect(inquiry.status).toBe("answered");
    expect(inquiry.claims[0]?.citations).toHaveLength(1);
    expect(adapter.supportInputs).toHaveLength(1);
  });

  it("rejects cites for chunks not returned by search", async () => {
    const caseId = await createCaseWithDocs(fixture, "agent 无效引用", [
      { filename: "intel.txt", content: "舰船线索：巡逻编队在港外集结。" },
    ]);

    const inquiry = await createService(fixture, new DynamicInquiryAdapter("invalid-cite")).ask(OPERATOR, caseId, "舰船线索");

    expect(inquiry.status).toBe("insufficient");
    expect(inquiry.claims[0]?.status).toBe("unverified");
    expect(inquiry.claims[0]?.citations).toHaveLength(0);
  });

  it("rejects cites whose chunk hash no longer matches the text", async () => {
    const caseId = (await fixture.cases.create(OPERATOR, { name: "agent 篡改引用", clearance: "internal" })).id;
    const [material] = await fixture.materials.ingest(OPERATOR, caseId, [
      { filename: "intel.txt", content: "舰船线索：码头发现异常装载。" },
    ]);
    await tamperFirstChunkHash(fixture, caseId, material);

    const inquiry = await createService(fixture, new DynamicInquiryAdapter("tampered")).ask(OPERATOR, caseId, "舰船线索");

    expect(inquiry.status).toBe("insufficient");
    expect(inquiry.claims[0]?.status).toBe("unverified");
    expect(inquiry.claims[0]?.citations).toHaveLength(0);
  });

  it("guards text LLM egress before every generate and records deny/refuse", async () => {
    const caseId = await createCaseWithDocs(fixture, "agent 外发拦截", [
      { filename: "intel.txt", content: "舰船线索：发现异常无线电呼号。" },
    ]);
    let called = false;
    const deniedAdapter: ModelAdapter = {
      name: "denied",
      async generate(): Promise<GenerateResult> {
        called = true;
        return final();
      },
    };

    await expect(createService(fixture, deniedAdapter, { allowlist: [] }).ask(OPERATOR, caseId, "舰船线索"))
      .rejects.toMatchObject({ status: 403 });
    expect(called).toBe(false);
    expect((await fixture.audit.readAll()).some((event) => event.action === "egress.deny" && event.result === "deny")).toBe(true);

    await expect(createService(fixture, new DynamicInquiryAdapter("valid"), { endpoint: "" }).ask(OPERATOR, caseId, "舰船线索"))
      .rejects.toMatchObject({ status: 503 });
  });

  it("audits successful tool calls, text LLM egress, and inquiry creation with a valid hash chain", async () => {
    const caseId = await createCaseWithDocs(fixture, "agent 审计", [
      { filename: "intel.txt", content: "舰船线索：补给船在夜间靠泊。" },
    ]);

    await createService(fixture, new DynamicInquiryAdapter("valid")).ask(OPERATOR, caseId, "舰船线索");

    expect(await fixture.audit.verify()).toMatchObject({ ok: true });
    const events = await fixture.audit.readAll();
    const actions = events.map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(["tool.search_chunks", "tool.cite", "egress.allow", "inquiry.create"]));
    const createEvent = events.find((event) => event.action === "inquiry.create");
    expect(createEvent?.detail?.runId).toEqual(expect.any(String));
    expect(createEvent?.detail?.runId).not.toBe("");
    expect(createEvent?.detail?.sessionId).toEqual(expect.any(String));
    expect(createEvent?.detail?.sessionId).not.toBe("");
  });

  it("keeps concurrent asks on the shared agent scoped to their own cases", async () => {
    const caseA = await createCaseWithDocs(fixture, "agent 并发 A", [
      { filename: "alpha.txt", content: "舰船线索：A 专题发现蓝色货轮。" },
    ]);
    const caseB = await createCaseWithDocs(fixture, "agent 并发 B", [
      { filename: "bravo.txt", content: "舰船线索：B 专题发现红色拖船。" },
    ]);
    const service = createService(fixture, new DynamicInquiryAdapter("valid"));

    const [a, b] = await Promise.all([
      service.ask(OPERATOR, caseA, "A 专题舰船线索"),
      service.ask(OPERATOR, caseB, "B 专题舰船线索"),
    ]);

    expect(a.status).toBe("answered");
    expect(b.status).toBe("answered");
    expect(a.claims[0]?.citations[0]?.material_name).toBe("alpha.txt");
    expect(b.claims[0]?.citations[0]?.material_name).toBe("bravo.txt");
  });

  it("advertises exactly the read-only intel tools plus activate_skill to the model", async () => {
    const caseId = await createCaseWithDocs(fixture, "agent 工具集", [
      { filename: "intel.txt", content: "舰船线索：岸台记录到异常通信。" },
    ]);
    const adapter = new DynamicInquiryAdapter("valid");

    await createService(fixture, adapter).ask(OPERATOR, caseId, "舰船线索");

    // 受控 intel 工具 + activate_skill（渐进式加载技能，只读）；精确匹配守住"不泄漏 bash/write"红线。
    expect(adapter.inputs[0]!.tools.map((tool) => tool.name).sort()).toEqual([
      "activate_skill",
      "add_claim",
      "cite",
      "expand_chunk",
      "finalize_answer",
      "list_materials",
      "read_chunk",
      "read_material_window",
      "search_chunks",
      "search_materials",
      "submit_finding",
    ]);
  });

  it("lets the agent browse a material window without retrieval search", async () => {
    const caseId = await createCaseWithDocs(fixture, "agent 窗口浏览", [
      { filename: "intel.txt", content: "窗口线索：码头东侧出现异常装载。" },
    ]);
    const adapter = new DynamicInquiryAdapter("window");

    const inquiry = await createService(fixture, adapter).ask(OPERATOR, caseId, "浏览材料找线索");

    expect(inquiry.status).toBe("answered");
    expect(inquiry.claims[0]?.citations[0]?.material_name).toBe("intel.txt");
    expect(inquiry.claims[0]?.citations[0]?.quote).toBe("窗口线索");
    const actions = (await fixture.audit.readAll()).map((event) => event.action);
    expect(actions).toContain("tool.list_materials");
    expect(actions).toContain("tool.read_material_window");
    expect(actions).not.toContain("tool.search_chunks");
  });

  it("feeds provider tool-argument errors back to the agent before failing the inquiry", async () => {
    const caseId = await createCaseWithDocs(fixture, "agent 工具参数修复", [
      { filename: "intel.txt", content: "舰船线索：岸台记录到异常通信。" },
    ]);
    const adapter = new DynamicInquiryAdapter("tool-args-error");

    const inquiry = await createService(fixture, adapter).ask(OPERATOR, caseId, "舰船线索");

    expect(inquiry.status).toBe("answered");
    expect(inquiry.answer).toContain("发现舰船线索");
    const repairInput = adapter.inputs.find((input) =>
      input.messages.some((message) => message.role === "user" && message.content.includes("工具调用参数格式不合法")),
    );
    expect(repairInput).toBeDefined();
    expect(repairInput?.messages.some((message) => message.role === "user" && message.content.includes("Provider returned invalid tool arguments for search_materials"))).toBe(true);
  });

  it("exposes explicit skills to the agent and honors skills.json disable on the next ask", async () => {
    const skillDirs = [await writeSkillDir(fixture.root, "demo-skill", "演示用技能")];
    const caseId = await createCaseWithDocs(fixture, "agent 技能接通", [
      { filename: "intel.txt", content: "舰船线索：岸台记录到异常通信。" },
    ]);
    const adapter = new DynamicInquiryAdapter("valid");
    const service = createService(fixture, adapter, { skillDirs });
    // 仅看 agent 循环轮次（有工具）；支持性校验是无工具的旁路调用，systemPrompt 不含 catalog。
    const agentPrompts = (): string[] => adapter.inputs.filter((input) => input.tools.length > 0).map((input) => input.systemPrompt);

    // 启用态：技能进入 agent 的系统提示 catalog（渐进式披露，仅 frontmatter）。
    await service.ask(OPERATOR, caseId, "舰船线索");
    const enabledPrompts = agentPrompts();
    expect(enabledPrompts[0]).toContain("demo-skill");

    // 后台禁用（写入 admin 同一路径 configDir/skills.json）。
    await mkdir(fixture.paths.configDir, { recursive: true });
    await writeFile(path.join(fixture.paths.configDir, "skills.json"), `${JSON.stringify({ "demo-skill": false })}\n`, "utf8");

    // 同一 service 的下一次 ask：revision none→hash 触发缓存重建，禁用技能不再出现在 catalog。
    const before = enabledPrompts.length;
    await service.ask(OPERATOR, caseId, "再查舰船线索");
    const allPrompts = agentPrompts();
    expect(allPrompts.length).toBeGreaterThan(before);
    expect(allPrompts.slice(before).every((prompt) => !prompt.includes("demo-skill"))).toBe(true);
  });

  it("caps read_chunk by the run read budget and still allows finalize", async () => {
    const longText = `舰船线索：${"A".repeat(300)}`;
    const caseId = await createCaseWithDocs(fixture, "agent 预算", [{ filename: "long.txt", content: longText }]);
    const adapter = new DynamicInquiryAdapter("budget");

    const inquiry = await createService(fixture, adapter, { readBudgetBytes: 40, perReadCapBytes: 100 }).ask(OPERATOR, caseId, "舰船线索");

    expect(inquiry.status).toBe("answered");
    expect(Buffer.byteLength(adapter.readContents[0] ?? "", "utf8")).toBeLessThanOrEqual(40);
    expect(adapter.readContents.some((content) => content.includes("读取预算已用尽"))).toBe(true);
  });

  it("refuses zero chunks, repairs missing finalize, and rejects finalize with only invalid cites", async () => {
    const emptyCase = (await fixture.cases.create(OPERATOR, { name: "agent 空专题", clearance: "internal" })).id;
    const empty = await createService(fixture, new DynamicInquiryAdapter("valid")).ask(OPERATOR, emptyCase, "舰船线索");
    expect(empty.status).toBe("insufficient");

    const noFinalizeCase = await createCaseWithDocs(fixture, "agent 无 finalize", [
      { filename: "intel.txt", content: "舰船线索：未见异常。" },
    ]);
    const repairAdapter = new DynamicInquiryAdapter("no-finalize");
    const noFinalize = await createService(fixture, repairAdapter).ask(OPERATOR, noFinalizeCase, "舰船线索");
    expect(noFinalize.status).toBe("answered");
    expect(noFinalize.answer).not.toContain("raw final text");
    expect(noFinalize.claims[0]?.citations[0]?.material_name).toBe("intel.txt");
    const repairInput = repairAdapter.inputs.find((input) => input.messages.some((message) => message.role === "user" && message.content.includes("上一轮自然语言结尾只是草稿")));
    expect(repairInput).toBeDefined();
    expect(repairInput?.messages.some((message) => message.role === "tool" && message.toolName === "search_chunks")).toBe(true);
    expect(repairInput?.messages.some((message) => message.role === "tool" && message.toolName === "cite")).toBe(true);
    expect(repairAdapter.supportInputs.some((input) => String(input.messages[0]?.content ?? "").includes("素材片段"))).toBe(false);
    const createEvent = (await fixture.audit.readAll()).find((event) => event.action === "inquiry.create" && event.detail?.inquiryId === noFinalize.id);
    expect(createEvent?.detail).toMatchObject({ finalized: true });
    expect(createEvent?.detail).not.toHaveProperty("fallback");

    const invalidOnly = await createService(fixture, new DynamicInquiryAdapter("invalid-cite")).ask(OPERATOR, noFinalizeCase, "舰船线索");
    expect(invalidOnly.status).toBe("insufficient");
    expect(invalidOnly.claims[0]?.status).toBe("unverified");
  });

  it("defaults to the agent ledger path when MINI_AGENT_INQUIRY_MODE is unset", async () => {
    delete process.env.MINI_AGENT_INQUIRY_MODE;
    const caseId = await createCaseWithDocs(fixture, "agent 默认", [
      { filename: "intel.txt", content: "舰船线索：默认 agent 路径可回答。" },
    ]);
    const adapter = new DynamicInquiryAdapter("valid");

    const inquiry: Inquiry = await createService(fixture, adapter).ask(OPERATOR, caseId, "舰船线索");

    expect(inquiry.status).toBe("answered");
    expect(adapter.inputs[0]?.tools.map((tool) => tool.name)).toContain("cite");
    expect(inquiry.claims[0]?.citations[0]?.quote).toBe("舰船线索");
    expect(inquiry.claims[0]?.citations[0]?.support_label).toBe("supports");
  });

  it("keeps the single-shot path only when MINI_AGENT_INQUIRY_MODE=single", async () => {
    process.env.MINI_AGENT_INQUIRY_MODE = "single";
    const caseId = await createCaseWithDocs(fixture, "single 默认", [
      { filename: "intel.txt", content: "舰船线索：默认单发路径仍可回答。" },
    ]);
    let input: GenerateInput | null = null;
    const adapter: ModelAdapter = {
      name: "single-json",
      async generate(generateInput): Promise<GenerateResult> {
        input = generateInput;
        const chunkId = (await fixture.materials.loadCaseChunks(caseId))[0]!.chunk_id;
        return {
          message: {
            role: "assistant",
            content: JSON.stringify({ claims: [{ text: "默认单发路径仍可回答", type: "fact", citations: [chunkId] }] }),
          },
          stopReason: "end_turn",
        };
      },
    };

    const inquiry: Inquiry = await createService(fixture, adapter).ask(OPERATOR, caseId, "舰船线索");

    expect(inquiry.status).toBe("answered");
    expect(input?.tools).toEqual([]);
  });

  it("routes deep inquiries through the agent path with an expanded read budget", async () => {
    const caseId = await createCaseWithDocs(fixture, "agent 深度", [
      { filename: "long.txt", content: `舰船线索：${"A".repeat(100)}` },
    ]);
    const adapter = new DynamicInquiryAdapter("budget");

    const inquiry = await createService(fixture, adapter, { readBudgetBytes: 20, perReadCapBytes: 100 }).ask(OPERATOR, caseId, "舰船线索", { deep: true });

    expect(inquiry.status).toBe("answered");
    expect(adapter.inputs[0]?.tools.map((tool) => tool.name)).toContain("search_chunks");
    expect(Buffer.byteLength(adapter.readContents[0] ?? "", "utf8")).toBeGreaterThan(20);
    expect(Buffer.byteLength(adapter.readContents[0] ?? "", "utf8")).toBeLessThanOrEqual(40);
  });
});
