import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { GenerateInput, GenerateResult, ModelAdapter } from "mini-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Chunk, Identity } from "../src/domain/types.js";
import { MaterialService } from "../src/materials/material-service.js";
import { ContradictionService } from "../src/analysis/contradiction-service.js";
import { OfflineGuard } from "../src/security/offline-guard.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const ENDPOINT = "https://stub.local/v1";

type Script = Record<string, unknown> | GenerateResult | Error | ((input: GenerateInput) => Record<string, unknown> | GenerateResult);

function isGenerateResult(value: Record<string, unknown> | GenerateResult): value is GenerateResult {
  return typeof (value as GenerateResult).message === "object";
}

function toolCall(name: string, args: Record<string, unknown>, id = `call_${name}`): GenerateResult {
  return {
    message: { role: "assistant", content: "", toolCalls: [{ id, name, arguments: args }] },
    stopReason: "tool_use",
  };
}

function final(content = "done"): GenerateResult {
  return { message: { role: "assistant", content }, stopReason: "end_turn" };
}

function toolResults(input: GenerateInput, name: string): { ok: boolean; content: string }[] {
  return input.messages
    .filter((message) => message.role === "tool" && message.toolName === name)
    .map((message) => JSON.parse(message.content) as { ok: boolean; content: string });
}

class ScriptedJsonAdapter implements ModelAdapter {
  readonly name = "scripted-contradiction";
  readonly inputs: GenerateInput[] = [];

  constructor(private readonly scripts: Script[]) {}

  async generate(input: GenerateInput): Promise<GenerateResult> {
    this.inputs.push(input);
    const script = this.scripts.shift();
    if (!script) throw new Error("unexpected model call");
    if (script instanceof Error) throw script;
    const body = typeof script === "function" ? script(input) : script;
    if (isGenerateResult(body)) return body;
    return { message: { role: "assistant", content: JSON.stringify(body) }, stopReason: "end_turn" };
  }
}

class CallbackJsonAdapter implements ModelAdapter {
  readonly name = "callback-contradiction";
  readonly inputs: GenerateInput[] = [];

  constructor(private readonly fn: (input: GenerateInput) => Record<string, unknown> | GenerateResult | Error) {}

  async generate(input: GenerateInput): Promise<GenerateResult> {
    this.inputs.push(input);
    const body = this.fn(input);
    if (body instanceof Error) throw body;
    if (isGenerateResult(body)) return body;
    return { message: { role: "assistant", content: JSON.stringify(body) }, stopReason: "end_turn" };
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
  const root = await mkdtemp(path.join(tmpdir(), "iw-contradiction-"));
  const paths = resolveDataPaths(root);
  const audit = new AuditService(paths);
  const cases = new CaseService(paths, audit, false);
  const materials = new MaterialService(paths, audit, cases);
  return { root, paths, audit, cases, materials };
}

function createService(fixture: Fixture, adapter: ModelAdapter): ContradictionService {
  return new ContradictionService(
    fixture.paths,
    fixture.audit,
    fixture.cases,
    fixture.materials,
    { adapter, guard: new OfflineGuard(["stub.local"], fixture.audit), modelEndpoint: ENDPOINT },
  );
}

async function createCaseWithDocs(fixture: Fixture, docs: { filename: string; content: string }[]): Promise<{ caseId: string; chunks: Chunk[] }> {
  const caseId = (await fixture.cases.create(OPERATOR, { name: "矛盾检测专题", clearance: "internal" })).id;
  await fixture.materials.ingest(OPERATOR, caseId, docs);
  return { caseId, chunks: await fixture.materials.loadCaseChunks(caseId) };
}

function extractClaims(chunks: Chunk[], values: string[]): Record<string, unknown> {
  return {
    claims: chunks.map((chunk, i) => ({
      entity: "USS Gerald Ford",
      attribute: "displacement",
      value: values[i] ?? values[0] ?? "",
      chunk_id: chunk.chunk_id,
    })),
  };
}

function chunkIds(content: string): string[] {
  return [...content.matchAll(/\[([^\]]+#\d+)\]/g)].map((match) => match[1]!);
}

function firstListedMaterialId(input: GenerateInput): string {
  const [list] = toolResults(input, "list_materials");
  const materials = JSON.parse(list?.content ?? "[]") as { material_id: string }[];
  return materials[0]?.material_id ?? "missing-material";
}

function windowChunkIds(input: GenerateInput): string[] {
  const [window] = toolResults(input, "read_material_window");
  const result = JSON.parse(window?.content ?? "{}") as { chunks?: { chunk_id: string }[] };
  return result.chunks?.map((chunk) => chunk.chunk_id) ?? [];
}

const contradiction = { relation: "contradiction", rationale: "values differ", certainty: 0.9 };
const deterministicContradiction = { relation: "contradiction", rationale: "values differ", certainty: 0.7 };

describe("ContradictionService", () => {
  let fixture: Fixture;
  let originalAgentMode: string | undefined;

  beforeEach(async () => {
    originalAgentMode = process.env.MINI_AGENT_CONTRADICTION_MODE;
    delete process.env.MINI_AGENT_CONTRADICTION_MODE;
    fixture = await createFixture();
  });

  afterEach(async () => {
    if (originalAgentMode === undefined) delete process.env.MINI_AGENT_CONTRADICTION_MODE;
    else process.env.MINI_AGENT_CONTRADICTION_MODE = originalAgentMode;
    await rm(fixture.root, { recursive: true, force: true });
  });

  it("detects a cross-material contradiction with grounded citations", async () => {
    const { caseId, chunks } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "USS Gerald Ford displacement is 100000 tons." },
      { filename: "bravo.txt", content: "USS Gerald Ford displacement is 85000 tons." },
    ]);
    const adapter = new ScriptedJsonAdapter([extractClaims(chunks, ["100000", "85000"]), contradiction]);

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);

    expect(result).toMatchObject({ status: "succeeded", processedChunks: 2, totalChunks: 2, truncated: false, warnings: [] });
    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0]?.scope).toBe("cross-material");
    expect(result.contradictions[0]?.claim_a.citation.content_hash).toEqual(expect.any(String));
    expect(result.contradictions[0]?.claim_b.citation.content_hash).toEqual(expect.any(String));
  });

  it("agent mode can submit contradictions through tools", async () => {
    process.env.MINI_AGENT_CONTRADICTION_MODE = "agent";
    const { caseId, chunks } = await createCaseWithDocs(fixture, [
      {
        filename: "single.txt",
        content: [
          `Gate 3 status is open. ${"A".repeat(520)}`,
          "Gate 3 status is closed.",
        ].join("\n\n"),
      },
    ]);
    const adapter = new CallbackJsonAdapter((input) => {
      if (input.tools.length === 0) {
        const ids = chunkIds(input.messages[0]?.content ?? "");
        return {
          claims: [
            { entity: "Gate 3", attribute: "status", value: "open", chunk_id: ids[0] ?? chunks[0]!.chunk_id },
            { entity: "Gate 3", attribute: "status", value: "closed", chunk_id: ids[0] ?? chunks[0]!.chunk_id },
          ],
        };
      }
      const has = (name: string) => toolResults(input, name).length > 0;
      if (!has("list_materials")) return toolCall("list_materials", {}, "list");
      if (!has("read_material_window")) return toolCall("read_material_window", { material_id: firstListedMaterialId(input), start_chunk: 0, limit: 2 }, "read");
      if (!has("extract_claims_from_scope")) return toolCall("extract_claims_from_scope", { chunk_ids: windowChunkIds(input) }, "extract");
      if (!has("compare_claims")) return toolCall("compare_claims", { claim_a_id: "claim-1", claim_b_id: "claim-2" }, "compare");
      if (!has("commit_contradictions")) {
        return toolCall("commit_contradictions", {
          contradictions: [{ claim_a_id: "claim-1", claim_b_id: "claim-2", rationale: "opposite statuses", confidence: 0.91 }],
        }, "commit");
      }
      return final();
    });

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);

    expect(result).toMatchObject({ status: "succeeded", contradictions: [expect.objectContaining({ rationale: "opposite statuses", confidence: 0.91 })] });
    expect(result.groundedPropositions.map((claim) => (claim as { claim_id?: string }).claim_id)).toEqual(["claim-1", "claim-2"]);
    expect(adapter.inputs.some((input) => input.tools.some((tool) => tool.name === "commit_contradictions"))).toBe(true);
    const events = await fixture.audit.readAll();
    expect(events.some((item) => item.action === "tool.commit_contradictions" && item.result === "ok")).toBe(true);
    const event = events.filter((item) => item.action === "contradiction.detect").pop();
    expect(event?.detail).toMatchObject({ agentic: { mode: "agent", status: "committed", claims: 2, pairsJudged: 1 } });
  });

  it("agent mode accumulates multiple commit_contradictions calls", async () => {
    process.env.MINI_AGENT_CONTRADICTION_MODE = "agent";
    const { caseId, chunks } = await createCaseWithDocs(fixture, [{
      filename: "multi.txt",
      content: [
        `Gate 3 status is open. ${"A".repeat(520)}`,
        `Gate 3 status is closed. ${"B".repeat(520)}`,
        `Gate 4 access is yes. ${"C".repeat(520)}`,
        "Gate 4 access is no.",
      ].join("\n\n"),
    }]);
    const adapter = new CallbackJsonAdapter((input) => {
      if (input.tools.length === 0) {
        const ids = chunkIds(input.messages[0]?.content ?? "");
        if ((input.messages[0]?.content ?? "").includes("claim_a:")) return contradiction;
        return {
          claims: [
            { entity: "Gate 3", attribute: "status", value: "open", chunk_id: ids[0] ?? chunks[0]!.chunk_id },
            { entity: "Gate 3", attribute: "status", value: "closed", chunk_id: ids[1] ?? chunks[1]!.chunk_id },
            { entity: "Gate 4", attribute: "access", value: "yes", chunk_id: ids[2] ?? chunks[2]!.chunk_id },
            { entity: "Gate 4", attribute: "access", value: "no", chunk_id: ids[2] ?? chunks[2]!.chunk_id },
          ],
        };
      }
      const compares = toolResults(input, "compare_claims").length;
      const commits = toolResults(input, "commit_contradictions").length;
      if (toolResults(input, "list_materials").length === 0) return toolCall("list_materials", {}, "list");
      if (toolResults(input, "read_material_window").length === 0) return toolCall("read_material_window", { material_id: firstListedMaterialId(input), start_chunk: 0, limit: 8 }, "read");
      if (toolResults(input, "extract_claims_from_scope").length === 0) return toolCall("extract_claims_from_scope", { chunk_ids: windowChunkIds(input) }, "extract");
      if (compares === 0) return toolCall("compare_claims", { claim_a_id: "claim-1", claim_b_id: "claim-2" }, "compare-1");
      if (commits === 0) return toolCall("commit_contradictions", { contradictions: [{ claim_a_id: "claim-1", claim_b_id: "claim-2" }] }, "commit-1");
      if (compares === 1) return toolCall("compare_claims", { claim_a_id: "claim-3", claim_b_id: "claim-4" }, "compare-2");
      if (commits === 1) return toolCall("commit_contradictions", { contradictions: [{ claim_a_id: "claim-3", claim_b_id: "claim-4" }] }, "commit-2");
      return final();
    });

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);

    expect(result.contradictions).toHaveLength(2);
    expect(toolResults(adapter.inputs.at(-1)!, "commit_contradictions")).toHaveLength(2);
  });

  it("does not compare different attributes or planned facts with observations", async () => {
    const { caseId, chunks } = await createCaseWithDocs(fixture, [
      { filename: "plan.txt", content: "蓝海星号计划于22:30靠泊东3泊位。" },
      { filename: "status.txt", content: "23:10蓝海星号仍在外锚地等待。" },
    ]);
    const adapter = new CallbackJsonAdapter((input) => {
      if ((input.messages[0]?.content ?? "").includes("claim_a:")) return contradiction;
      return {
        claims: [
          { entity: "蓝海星号", attribute: "靠泊状态", value: "东3泊位", modality: "planned", chunk_id: chunks[0]!.chunk_id },
          { entity: "蓝海星号", attribute: "靠泊状态", value: "外锚地等待", modality: "asserted", chunk_id: chunks[1]!.chunk_id },
        ],
      };
    });

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);

    expect(result.contradictions).toHaveLength(0);
    expect(adapter.inputs.filter((input) => input.messages[0]?.content.includes("claim_a:"))).toHaveLength(0);
  });

  it("does not treat values from different points in one time series as contradictions", async () => {
    const { caseId, chunks } = await createCaseWithDocs(fixture, [{
      filename: "ais.txt",
      content: "2026-07-01 22:18:00 / SOG 0.1\n2026-07-01 23:27:00 / SOG 2.4",
    }]);
    const adapter = new CallbackJsonAdapter((input) => {
      if ((input.messages[0]?.content ?? "").includes("claim_a:")) return new Error("different timestamps must not be judged");
      return {
        claims: [
          { entity: "蓝海星号", attribute: "AIS 航速", value: "0.1", chunk_id: chunks[0]!.chunk_id },
          { entity: "蓝海星号", attribute: "AIS 航速", value: "2.4", chunk_id: chunks[0]!.chunk_id },
        ],
      };
    });

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);

    expect(result.contradictions).toHaveLength(0);
    expect(result.groundedPropositions.map((claim) => claim.time)).toEqual(["2026-07-01 22:18:00", "2026-07-01 23:27:00"]);
  });

  it("agent mode falls back to batch detection when the agent does not commit", async () => {
    process.env.MINI_AGENT_CONTRADICTION_MODE = "agent";
    const { caseId, chunks } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "Gate 3 status is open." },
      { filename: "bravo.txt", content: "Gate 3 status is closed." },
    ]);
    const adapter = new CallbackJsonAdapter((input) => {
      if (input.tools.length === 0) return extractClaims(chunks, ["open", "closed"]);
      return final();
    });

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);

    expect(result.contradictions).toHaveLength(1);
    expect(result.status).toBe("degraded");
    expect(result.warnings).toContainEqual(expect.stringContaining("commit_contradictions"));
    expect(adapter.inputs.filter((input) => input.tools.length > 0)).toHaveLength(2);
  });

  it("agent commit rejects unknown claim ids and then falls back", async () => {
    process.env.MINI_AGENT_CONTRADICTION_MODE = "agent";
    const { caseId } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "No contradiction here." },
    ]);
    const adapter = new CallbackJsonAdapter((input) => {
      if (input.tools.length === 0) return { claims: [] };
      if (toolResults(input, "commit_contradictions").length === 0) {
        return toolCall("commit_contradictions", {
          contradictions: [{ claim_a_id: "missing-a", claim_b_id: "missing-b" }],
        }, "bad_commit");
      }
      return final();
    });

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);
    const commitResult = adapter.inputs.flatMap((input) => toolResults(input, "commit_contradictions"))[0];

    expect(commitResult).toMatchObject({ ok: false, content: expect.stringContaining("未知 claim_id") });
    expect(result).toMatchObject({ status: "degraded", contradictions: [] });
    expect(result.warnings).toContainEqual(expect.stringContaining("commit_contradictions"));
  });

  it("agent commit rejects pairs that did not pass contradiction judgement", async () => {
    process.env.MINI_AGENT_CONTRADICTION_MODE = "agent";
    const { caseId, chunks } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "Gate 3 status is open." },
    ]);
    const adapter = new CallbackJsonAdapter((input) => {
      if (input.tools.length === 0) {
        const ids = chunkIds(input.messages[0]?.content ?? "");
        return {
          claims: [
            { entity: "Gate 3", attribute: "status", value: "open", chunk_id: ids[0] ?? chunks[0]!.chunk_id },
            { entity: "Gate 3", attribute: "status", value: "open", chunk_id: ids[0] ?? chunks[0]!.chunk_id },
          ],
        };
      }
      const has = (name: string) => toolResults(input, name).length > 0;
      if (!has("list_materials")) return toolCall("list_materials", {}, "list");
      if (!has("read_material_window")) return toolCall("read_material_window", { material_id: firstListedMaterialId(input), start_chunk: 0, limit: 1 }, "read");
      if (!has("extract_claims_from_scope")) return toolCall("extract_claims_from_scope", { chunk_ids: windowChunkIds(input) }, "extract");
      if (!has("commit_contradictions")) {
        return toolCall("commit_contradictions", {
          contradictions: [{ claim_a_id: "claim-1", claim_b_id: "claim-2", rationale: "agent tried to force commit" }],
        }, "commit");
      }
      return final();
    });

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);
    const commitResult = adapter.inputs.flatMap((input) => toolResults(input, "commit_contradictions"))[0];

    expect(commitResult).toMatchObject({ ok: false, content: expect.stringContaining("未通过矛盾判定") });
    expect(result).toMatchObject({ status: "degraded", contradictions: [] });
  });

  it("agent commit rejects cross-entity claim pairs", async () => {
    process.env.MINI_AGENT_CONTRADICTION_MODE = "agent";
    const { caseId, chunks } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "Gate 3 status is open. Gate 4 status is closed." },
    ]);
    const adapter = new CallbackJsonAdapter((input) => {
      if (input.tools.length === 0) {
        const ids = chunkIds(input.messages[0]?.content ?? "");
        return {
          claims: [
            { entity: "Gate 3", attribute: "status", value: "open", chunk_id: ids[0] ?? chunks[0]!.chunk_id },
            { entity: "Gate 4", attribute: "status", value: "closed", chunk_id: ids[0] ?? chunks[0]!.chunk_id },
          ],
        };
      }
      const has = (name: string) => toolResults(input, name).length > 0;
      if (!has("list_materials")) return toolCall("list_materials", {}, "list");
      if (!has("read_material_window")) return toolCall("read_material_window", { material_id: firstListedMaterialId(input), start_chunk: 0, limit: 1 }, "read");
      if (!has("extract_claims_from_scope")) return toolCall("extract_claims_from_scope", { chunk_ids: windowChunkIds(input) }, "extract");
      if (!has("commit_contradictions")) {
        return toolCall("commit_contradictions", {
          contradictions: [{ claim_a_id: "claim-1", claim_b_id: "claim-2", rationale: "cross entity forced commit" }],
        }, "commit");
      }
      return final();
    });

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);
    const commitResult = adapter.inputs.flatMap((input) => toolResults(input, "commit_contradictions"))[0];

    expect(commitResult).toMatchObject({ ok: false, content: expect.stringContaining("实体不一致") });
    expect(result).toMatchObject({ status: "degraded", contradictions: [] });
  });

  it("agent runtime errors fail instead of falling back silently", async () => {
    process.env.MINI_AGENT_CONTRADICTION_MODE = "agent";
    const { caseId } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "Gate 3 status is open." },
    ]);
    const service = new ContradictionService(
      fixture.paths,
      fixture.audit,
      fixture.cases,
      fixture.materials,
      { adapter: new ScriptedJsonAdapter([new Error("agent exploded")]), guard: new OfflineGuard(["stub.local"], fixture.audit), modelEndpoint: ENDPOINT },
    );

    await expect(service.detect(OPERATOR, caseId)).rejects.toMatchObject({
      result: { status: "failed", error: expect.stringContaining("agent exploded") },
    });
  });

  it("default mode does not enter the agentic path", async () => {
    const { caseId, chunks } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "Gate 3 status is open." },
      { filename: "bravo.txt", content: "Gate 3 status is closed." },
    ]);
    const adapter = new CallbackJsonAdapter((input) => {
      if (input.tools.length > 0) return new Error("agentic path should not run");
      return extractClaims(chunks, ["open", "closed"]);
    });

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);

    expect(result.contradictions).toHaveLength(1);
    expect(adapter.inputs.every((input) => input.tools.length === 0)).toBe(true);
  });

  it("normalizes simple aliases, persists propositions, and leaves numeric conflicts to LLM", async () => {
    const { caseId, chunks } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "UNITED STATES COAST GUARD patrol count is 11." },
      { filename: "bravo.txt", content: "USCG patrol count is 12." },
    ]);
    const adapter = new ScriptedJsonAdapter([{
      claims: [
        { entity: "UNITED STATES COAST GUARD", attribute: "patrol count", value: "11", chunk_id: chunks[0]!.chunk_id },
        { entity: "USCG", attribute: "patrol count", value: "12", chunk_id: chunks[1]!.chunk_id },
      ],
    }, contradiction]);
    const service = createService(fixture, adapter);

    const result = await service.detect(OPERATOR, caseId);

    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0]).toMatchObject({
      normalized_entity: "unitedstatescoastguard",
      normalized_attribute: "patrolcount",
      value_a: "11",
      value_b: "12",
      rule_source: "llm",
    });
    expect(result.groundedPropositions.map((claim) => claim.normalized_entity)).toEqual(["unitedstatescoastguard", "unitedstatescoastguard"]);
    expect(adapter.inputs.filter((input) => input.messages[0]?.content.includes("claim_a:"))).toHaveLength(1);
    await expect(service.getResult(OPERATOR, caseId)).resolves.toMatchObject({
      groundedPropositions: [
        { entity: "UNITED STATES COAST GUARD", normalized_entity: "unitedstatescoastguard" },
        { entity: "USCG", normalized_entity: "unitedstatescoastguard" },
      ],
    });
  });

  it("uses case element aliases when normalizing contradiction entities", async () => {
    const { caseId, chunks } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "蓝海星号 draft is 8.1." },
      { filename: "bravo.txt", content: "Blue Star draft is 8.4." },
    ]);
    await writeFile(path.join(fixture.paths.caseDir(caseId), "elements.json"), JSON.stringify([
      { id: "el-ship", type: "equipment", name: "蓝海星号", aliases: ["Blue Star"], mentions: [], freq: 0 },
    ]));
    const adapter = new ScriptedJsonAdapter([{
      claims: [
        { entity: "蓝海星号", attribute: "draft", value: "8.1", chunk_id: chunks[0]!.chunk_id },
        { entity: "Blue Star", attribute: "draft", value: "8.4", chunk_id: chunks[1]!.chunk_id },
      ],
    }, contradiction]);

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);

    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0]).toMatchObject({
      normalized_entity: "蓝海星号",
      rule_source: "llm",
    });
    expect(adapter.inputs.filter((input) => input.messages[0]?.content.includes("claim_a:"))).toHaveLength(1);
  });

  it("does not flag numerically equal values with different formatting", async () => {
    const { caseId, chunks } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "LH-7712 draft is 8.10." },
      { filename: "bravo.txt", content: "LH-7712 draft is 8.1." },
    ]);
    const adapter = new ScriptedJsonAdapter([{
      claims: [
        { entity: "LH-7712", attribute: "draft", value: "8.10", chunk_id: chunks[0]!.chunk_id },
        { entity: "LH-7712", attribute: "draft", value: "8.1", chunk_id: chunks[1]!.chunk_id },
      ],
    }]);

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);

    expect(result.contradictions).toHaveLength(0);
    expect(adapter.inputs.filter((input) => input.messages[0]?.content.includes("claim_a:"))).toHaveLength(0);
  });

  it("cheap-rules opposite status conflicts without LLM judge", async () => {
    const { caseId, chunks } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "Gate 3 is open." },
      { filename: "bravo.txt", content: "Gate 3 is closed." },
    ]);
    const adapter = new ScriptedJsonAdapter([{
      claims: [
        { entity: "Gate 3", attribute: "status", value: "open", chunk_id: chunks[0]!.chunk_id },
        { entity: "Gate 3", attribute: "status", value: "closed", chunk_id: chunks[1]!.chunk_id },
      ],
    }]);

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);

    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0]).toMatchObject({ rule_source: "rule", rule_name: "opposite-status" });
    expect(adapter.inputs.filter((input) => input.messages[0]?.content.includes("claim_a:"))).toHaveLength(0);
  });

  it("does not collapse conflicting element aliases", async () => {
    const { caseId, chunks } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "X status is open." },
      { filename: "bravo.txt", content: "Beta status is closed." },
    ]);
    await writeFile(path.join(fixture.paths.caseDir(caseId), "elements.json"), JSON.stringify([
      { id: "el-alpha", type: "equipment", name: "Alpha", aliases: ["X"], mentions: [], freq: 0 },
      { id: "el-beta", type: "equipment", name: "Beta", aliases: ["X"], mentions: [], freq: 0 },
    ]));
    const adapter = new ScriptedJsonAdapter([{
      claims: [
        { entity: "X", attribute: "status", value: "open", chunk_id: chunks[0]!.chunk_id },
        { entity: "Beta", attribute: "status", value: "closed", chunk_id: chunks[1]!.chunk_id },
      ],
    }]);

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);

    expect(result.contradictions).toHaveLength(0);
  });

  it("ignores malformed optional elements alias file", async () => {
    const { caseId, chunks } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "Gate 3 status is open." },
      { filename: "bravo.txt", content: "Gate 3 status is closed." },
    ]);
    await writeFile(path.join(fixture.paths.caseDir(caseId), "elements.json"), "{bad json");
    const adapter = new ScriptedJsonAdapter([{
      claims: [
        { entity: "Gate 3", attribute: "status", value: "open", chunk_id: chunks[0]!.chunk_id },
        { entity: "Gate 3", attribute: "status", value: "closed", chunk_id: chunks[1]!.chunk_id },
      ],
    }]);

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);

    expect(result.contradictions).toHaveLength(1);
  });

  it("does not treat symbols stripped by display normalization as same values", async () => {
    const { caseId, chunks } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "Fee is $5." },
      { filename: "bravo.txt", content: "Fee is €5." },
    ]);
    const adapter = new ScriptedJsonAdapter([{
      claims: [
        { entity: "Fee schedule", attribute: "fee", value: "$5", chunk_id: chunks[0]!.chunk_id },
        { entity: "Fee schedule", attribute: "fee", value: "€5", chunk_id: chunks[1]!.chunk_id },
      ],
    }, { relation: "unrelated", rationale: "currency differs and needs context", certainty: 0.4 }]);

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);

    expect(result.contradictions).toHaveLength(0);
    expect(adapter.inputs.filter((input) => input.messages[0]?.content.includes("claim_a:"))).toHaveLength(1);
  });

  it("reports not-started coverage before the first detection run", async () => {
    const { caseId } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "USS Gerald Ford displacement is 100000 tons." },
    ]);

    await expect(createService(fixture, new ScriptedJsonAdapter([])).getResult(OPERATOR, caseId)).resolves.toMatchObject({
      notStarted: true,
      processedChunks: 0,
      totalChunks: 1,
      contradictions: [],
      groundedPropositions: [],
    });
  });

  it("出站被拒时显式抛出并记 error 审计（不静默吞成空结果）", async () => {
    const { caseId } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "USS Gerald Ford displacement is 100000 tons." },
    ]);
    // 端点不在白名单 → OfflineGuard 拒绝出站 → 检测必须失败（抛出），而非返回 [] 让任务呈 done+空。
    const service = new ContradictionService(
      fixture.paths,
      fixture.audit,
      fixture.cases,
      fixture.materials,
      { adapter: new ScriptedJsonAdapter([]), guard: new OfflineGuard([], fixture.audit), modelEndpoint: ENDPOINT },
    );

    await expect(service.detect(OPERATOR, caseId)).rejects.toMatchObject({
      result: {
        status: "failed",
        contradictions: [],
        processedChunks: 0,
        totalChunks: 1,
        truncated: true,
        error: expect.stringContaining("外发"),
      },
    });
    const events = await fixture.audit.readCaseEvents(caseId);
    expect(events.some((e) => e.action === "contradiction.detect" && e.result === "error")).toBe(true);
    await expect(service.getResult(OPERATOR, caseId)).resolves.toMatchObject({
      status: "failed",
      contradictions: [],
      processedChunks: 0,
      totalChunks: 1,
      truncated: true,
      error: expect.stringContaining("外发"),
    });
  });

  it("detects an intra-material contradiction", async () => {
    const { caseId, chunks } = await createCaseWithDocs(fixture, [
      {
        filename: "single.txt",
        content: [
          `USS Gerald Ford displacement is 100000 tons. ${"A".repeat(520)}`,
          "USS Gerald Ford displacement is 85000 tons.",
        ].join("\n\n"),
      },
    ]);
    const adapter = new ScriptedJsonAdapter([extractClaims(chunks, ["100000", "85000"]), contradiction]);

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);

    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0]?.scope).toBe("intra-material");
  });

  it("drops fabricated chunk references without crashing", async () => {
    const { caseId } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "USS Gerald Ford displacement is 100000 tons." },
      { filename: "bravo.txt", content: "USS Gerald Ford displacement is 85000 tons." },
    ]);
    const adapter = new ScriptedJsonAdapter([
      {
        claims: [
          { entity: "USS Gerald Ford", attribute: "displacement", value: "100000", chunk_id: "fabricated#0" },
          { entity: "USS Gerald Ford", attribute: "displacement", value: "85000", chunk_id: "fabricated#1" },
        ],
      },
    ]);

    await expect(createService(fixture, adapter).detect(OPERATOR, caseId)).resolves.toMatchObject({
      status: "succeeded",
      contradictions: [],
    });
  });

  it("does not emit agreements", async () => {
    const { caseId, chunks } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "USS Gerald Ford displacement is 100000 tons." },
      { filename: "bravo.txt", content: "USS Gerald Ford displacement is 100000 tons." },
    ]);
    const adapter = new ScriptedJsonAdapter([
      extractClaims(chunks, ["100000", "100000"]),
      { relation: "agreement", rationale: "same value", certainty: 0.9 },
    ]);

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);

    expect(result).toMatchObject({ status: "succeeded", contradictions: [] });
  });

  it("skips a failed extraction batch and records best-effort coverage", async () => {
    const { caseId } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "USS Gerald Ford displacement is 100000 tons." },
    ]);
    const adapter = new ScriptedJsonAdapter([new Error("extract failed")]);

    await expect(createService(fixture, adapter).detect(OPERATOR, caseId)).resolves.toMatchObject({
      status: "degraded",
      contradictions: [],
      processedChunks: 0,
      totalChunks: 1,
      truncated: true,
      warnings: [expect.stringContaining("批次")],
    });
    const event = (await fixture.audit.readAll()).filter((item) => item.action === "contradiction.detect").pop();
    expect(event?.result).toBe("ok");
    expect(event?.detail).toMatchObject({ batches: 1, chunksCovered: 0, chunksTotal: 1, failedBatches: 1 });
  });

  it("splits and retries a malformed multi-chunk extraction without accepting partial JSON", async () => {
    const { caseId, chunks } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "USS Gerald Ford displacement is 100000 tons." },
      { filename: "bravo.txt", content: "USS Gerald Ford displacement is 85000 tons." },
    ]);
    let extractionCalls = 0;
    const adapter = new CallbackJsonAdapter((input) => {
      const content = input.messages[0]?.content ?? "";
      if (content.includes("claim_a:")) return contradiction;
      extractionCalls += 1;
      if (extractionCalls === 1) return final('{"claims":[{"entity":"USS Gerald Ford"}');
      const id = chunkIds(content)[0]!;
      return {
        claims: [{
          entity: "USS Gerald Ford",
          attribute: "displacement",
          value: id === chunks[0]!.chunk_id ? "100000" : "85000",
          chunk_id: id,
        }],
      };
    });

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);

    expect(extractionCalls).toBe(3);
    expect(result).toMatchObject({ status: "succeeded", processedChunks: 2, totalChunks: 2, truncated: false });
    expect(result.contradictions).toHaveLength(1);
  });

  it("scores cross-source contradictions at least as high as same-source contradictions", async () => {
    const { caseId, chunks } = await createCaseWithDocs(fixture, [
      {
        filename: "alpha.txt",
        content: [
          `USS Gerald Ford displacement is 100000 tons. ${"A".repeat(520)}`,
          "USS Gerald Ford displacement is 90000 tons.",
        ].join("\n\n"),
      },
      { filename: "bravo.txt", content: "USS Gerald Ford displacement is 90000 tons." },
    ]);
    const adapter = new ScriptedJsonAdapter([
      extractClaims(chunks, ["100000", "90000", "90000"]),
      deterministicContradiction,
      deterministicContradiction,
      deterministicContradiction,
    ]);

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);
    const cross = result.contradictions.find((item) => item.scope === "cross-material");
    const intra = result.contradictions.find((item) => item.scope === "intra-material");

    expect(cross?.confidence).toBeGreaterThanOrEqual(intra?.confidence ?? 1);
  });

  it("extracts claims from all batches and detects contradictions across batches", async () => {
    const { caseId, chunks } = await createCaseWithDocs(fixture, Array.from({ length: 41 }, (_, i) => ({
      filename: `doc${i}.txt`,
      content: `USS Gerald Ford displacement is ${i === 40 ? "85000" : "100000"} tons in source ${i}.`,
    })));
    const first = chunks[0]!.chunk_id;
    const last = chunks[40]!.chunk_id;
    const adapter = new CallbackJsonAdapter((input) => {
      const content = input.messages[0]?.content ?? "";
      if (content.includes("claim_a:")) return contradiction;
      const ids = chunkIds(content);
      return {
        claims: ids.flatMap((id) => {
          if (id === first) return [{ entity: "USS Gerald Ford", attribute: "displacement", value: "100000", chunk_id: id }];
          if (id === last) return [{ entity: "USS Gerald Ford", attribute: "displacement", value: "85000", chunk_id: id }];
          return [];
        }),
      };
    });

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);

    expect(adapter.inputs.filter((input) => !input.messages[0]?.content.includes("claim_a:"))).toHaveLength(4);
    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0]?.claim_a.citation.content_hash).toBe(chunks[0]!.content_hash);
    expect(result.contradictions[0]?.claim_b.citation.content_hash).toBe(chunks[40]!.content_hash);
    const event = (await fixture.audit.readAll()).filter((item) => item.action === "contradiction.detect").pop();
    expect(event?.detail).toMatchObject({ batches: 4, chunksCovered: 41, chunksTotal: 41, failedBatches: 0 });
  });

  it("grounds claims only against the chunks fed to that extraction batch", async () => {
    const { caseId, chunks } = await createCaseWithDocs(fixture, Array.from({ length: 41 }, (_, i) => ({
      filename: `doc${i}.txt`,
      content: `USS Gerald Ford displacement is ${i} tons in source ${i}.`,
    })));
    const foreign = chunks[40]!.chunk_id;
    const adapter = new CallbackJsonAdapter((input) => {
      const content = input.messages[0]?.content ?? "";
      if (content.includes("claim_a:")) return contradiction;
      const ids = chunkIds(content);
      return {
        claims: ids.length === 40
          ? [{ entity: "USS Gerald Ford", attribute: "displacement", value: "100000", chunk_id: foreign }]
          : [],
      };
    });

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);

    expect(result).toMatchObject({ status: "succeeded", contradictions: [] });
    expect(adapter.inputs.filter((input) => input.messages[0]?.content.includes("claim_a:"))).toHaveLength(0);
  });
});
