import { describe, expect, it } from "vitest";

import type { Chunk, Identity, Material } from "../src/domain/types.js";
import { createCitationLedger, createIntelTools } from "../src/inquiry/intel-harness.js";
import { sha256 } from "../src/util/hash.js";

const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };

const MATERIALS: Material[] = [
  {
    id: "m1",
    case_id: "case-1",
    filename: "泊位记录.txt",
    modality: "doc",
    format: "txt",
    size: 100,
    ingested_at: "2026-07-03T00:00:00.000Z",
    status: "done",
  },
  {
    id: "m2",
    case_id: "case-1",
    filename: "门岗OCR.txt",
    modality: "doc",
    format: "txt",
    size: 100,
    ingested_at: "2026-07-03T00:00:00.000Z",
    status: "done",
  },
];

function chunk(material_id: string, index: number, text: string): Chunk {
  return {
    chunk_id: `${material_id}#${index}`,
    material_id,
    modality: "doc",
    locator: { paragraph: index + 1 },
    text,
    content_hash: sha256(text),
  };
}

function harness(chunks: Chunk[], opts: { readBudgetBytes?: number; perReadCapBytes?: number } = {}) {
  const ledger = createCitationLedger();
  const tools = createIntelTools({
    ledger,
    actor: OPERATOR,
    caseId: "case-1",
    nameById: new Map(MATERIALS.map((material) => [material.id, material.filename])),
    retrieve: async () => [],
    navigation: {
      listMaterials: async () => MATERIALS,
      loadChunks: async () => chunks,
    },
    readBudgetBytes: opts.readBudgetBytes ?? 10_000,
    perReadCapBytes: opts.perReadCapBytes ?? 10_000,
  });
  const exec = async (name: string, args: unknown) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return await tool.execute(args) as { ok: boolean; content: string };
  };
  return { ledger, exec };
}

describe("createIntelTools harness autonomy tools", () => {
  it("search_materials returns short deterministic hits and makes them citable", async () => {
    const chunks = [chunk("m1", 0, "前置 LH-7712 靠泊异常 后续")];
    const { ledger, exec } = harness(chunks);

    const result = await exec("search_materials", { query: "lh-7712", max_matches: 5, context_chars: 3 });

    expect(result.ok).toBe(true);
    const matches = JSON.parse(result.content) as Array<Record<string, unknown>>;
    expect(matches).toEqual([
      expect.objectContaining({
        material_id: "m1",
        material_name: "泊位记录.txt",
        modality: "doc",
        chunk_id: "m1#0",
        chunk_index: 0,
        before: "前置 ",
        match: "LH-7712",
        after: " 靠泊",
        locator: { paragraph: 1 },
      }),
    ]);
    expect(ledger.retrieved.has("m1#0")).toBe(true);

    const cite = await exec("cite", { chunk_id: "m1#0", claim: "LH-7712 靠泊异常", quote: "LH-7712" });
    expect(cite.ok).toBe(true);
    expect(ledger.cited.size).toBe(1);
  });

  it("search_materials honors material_id filtering", async () => {
    const chunks = [
      chunk("m1", 0, "三号门 OCR 命中"),
      chunk("m2", 0, "三号门 OCR 命中"),
    ];
    const { exec } = harness(chunks);

    const result = await exec("search_materials", { query: "OCR", material_id: "m2" });

    expect(result.ok).toBe(true);
    const matches = JSON.parse(result.content) as Array<{ material_id: string; chunk_id: string }>;
    expect(matches).toEqual([
      expect.objectContaining({
        material_id: "m2",
        material_name: "门岗OCR.txt",
        modality: "doc",
        chunk_id: "m2#0",
        chunk_index: 0,
        match: "OCR",
        locator: { paragraph: 1 },
      }),
    ]);
  });

  it("search_materials tolerates common model argument shapes", async () => {
    const chunks = [
      chunk("m1", 0, "三号门 登记异常"),
      chunk("m2", 0, "三号门 登记异常"),
    ];
    const ledger = createCitationLedger();
    const tool = createIntelTools({
      ledger,
      actor: OPERATOR,
      caseId: "case-1",
      nameById: new Map(MATERIALS.map((material) => [material.id, material.filename])),
      retrieve: async () => [],
      navigation: {
        listMaterials: async () => MATERIALS,
        loadChunks: async () => chunks,
      },
      readBudgetBytes: 10_000,
      perReadCapBytes: 10_000,
    }).find((candidate) => candidate.name === "search_materials")!;

    const parsed = tool.inputSchema.parse({ query: ["三号门"], material_id: null, max_matches: "1", context_chars: "2" });
    const result = await tool.execute(parsed) as { ok: boolean; content: string };

    expect(result.ok).toBe(true);
    const matches = JSON.parse(result.content) as Array<{ chunk_id: string }>;
    expect(matches).toHaveLength(1);
    expect(matches[0]!.chunk_id).toBe("m1#0");
  });

  it("search_materials does not reveal an entire short chunk as preview", async () => {
    const text = "入口日志显示 LH-7712 于二十三时十二分进入二号门";
    const { ledger, exec } = harness([chunk("m1", 0, text)]);

    const result = await exec("search_materials", { query: "LH-7712", context_chars: 200 });

    expect(result.ok).toBe(true);
    const matches = JSON.parse(result.content) as Array<{
      before: string;
      match: string;
      after: string;
      truncated_before?: boolean;
      truncated_after?: boolean;
      match_truncated?: boolean;
    }>;
    expect(`${matches[0]!.before}${matches[0]!.match}${matches[0]!.after}`).not.toBe(text);
    expect(Boolean(matches[0]!.truncated_before || matches[0]!.truncated_after || matches[0]!.match_truncated)).toBe(true);
    expect(ledger.readBytes).toBe(0);
  });

  it("search_materials caps long match previews", async () => {
    const longNeedle = "B".repeat(160);
    const { exec } = harness([chunk("m1", 0, `${"A".repeat(150)}${longNeedle}${"C".repeat(150)}`)]);

    const result = await exec("search_materials", { query: longNeedle, context_chars: 200 });

    expect(result.ok).toBe(true);
    const [match] = JSON.parse(result.content) as Array<{ before: string; match: string; after: string; match_truncated?: boolean }>;
    expect(match!.match.length).toBeLessThanOrEqual(80);
    expect(`${match!.before}${match!.match}${match!.after}`.length).toBeLessThanOrEqual(240);
    expect(match!.match_truncated).toBe(true);
  });

  it("search_materials rejects empty query", async () => {
    const { exec } = harness([chunk("m1", 0, "任意内容")]);

    const result = await exec("search_materials", { query: "   " });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("query");
  });

  it("expand_chunk only expands around chunks already in the ledger", async () => {
    const chunks = [
      chunk("m1", 0, "前一段"),
      chunk("m1", 1, "命中段"),
      chunk("m1", 2, "后一段"),
    ];
    const { ledger, exec } = harness(chunks);

    const denied = await exec("expand_chunk", { chunk_id: "m1#1", before: 1, after: 1 });
    expect(denied.ok).toBe(false);

    ledger.retrieved.set("m1#1", chunks[1]!);
    const result = await exec("expand_chunk", { chunk_id: "m1#1", before: 1, after: 1 });

    expect(result.ok).toBe(true);
    const expanded = JSON.parse(result.content) as { chunks: Array<{ chunk_id: string; chunk_index: number; text: string }> };
    expect(expanded.chunks.map((item) => [item.chunk_id, item.chunk_index, item.text])).toEqual([
      ["m1#0", 0, "前一段"],
      ["m1#1", 1, "命中段"],
      ["m1#2", 2, "后一段"],
    ]);
    expect([...ledger.retrieved.keys()].sort()).toEqual(["m1#0", "m1#1", "m1#2"]);
  });

  it("submit_finding stores structured cited findings in the ledger", async () => {
    const chunks = [chunk("m1", 0, "现场照片显示封志缺失。")];
    const { ledger, exec } = harness(chunks);
    ledger.retrieved.set("m1#0", chunks[0]!);
    const cite = await exec("cite", { chunk_id: "m1#0", claim: "现场封志缺失", quote: "封志缺失" });
    const citeId = (JSON.parse(cite.content) as { cite_id: string }).cite_id;

    const result = await exec("submit_finding", {
      conclusion: "现场照片显示封志缺失",
      supporting_cite_ids: [citeId],
      reasoning: "照片 OCR 文字直接支持",
      confidence: 0.8,
      severity: "high",
      open_questions: ["是否存在后续补录"],
    });

    expect(result.ok).toBe(true);
    expect(ledger.submittedFindings).toEqual([
      {
        conclusion: "现场照片显示封志缺失",
        supporting_cite_ids: [citeId],
        opposing_cite_ids: [],
        reasoning: "照片 OCR 文字直接支持",
        confidence: 0.8,
        severity: "high",
        open_questions: ["是否存在后续补录"],
      },
    ]);
  });
});
