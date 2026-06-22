import { mkdtemp, rm } from "node:fs/promises";
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

type Script = Record<string, unknown> | Error | ((input: GenerateInput) => Record<string, unknown>);

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
    return { message: { role: "assistant", content: JSON.stringify(body) }, stopReason: "end_turn" };
  }
}

class CallbackJsonAdapter implements ModelAdapter {
  readonly name = "callback-contradiction";
  readonly inputs: GenerateInput[] = [];

  constructor(private readonly fn: (input: GenerateInput) => Record<string, unknown> | Error) {}

  async generate(input: GenerateInput): Promise<GenerateResult> {
    this.inputs.push(input);
    const body = this.fn(input);
    if (body instanceof Error) throw body;
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

const contradiction = { relation: "contradiction", rationale: "values differ", certainty: 0.9 };
const deterministicContradiction = { relation: "contradiction", rationale: "values differ", certainty: 0.7 };

describe("ContradictionService", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  it("detects a cross-material contradiction with grounded citations", async () => {
    const { caseId, chunks } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "USS Gerald Ford displacement is 100000 tons." },
      { filename: "bravo.txt", content: "USS Gerald Ford displacement is 85000 tons." },
    ]);
    const adapter = new ScriptedJsonAdapter([extractClaims(chunks, ["100000", "85000"]), contradiction]);

    const result = await createService(fixture, adapter).detect(OPERATOR, caseId);

    expect(result).toHaveLength(1);
    expect(result[0]?.scope).toBe("cross-material");
    expect(result[0]?.claim_a.citation.content_hash).toEqual(expect.any(String));
    expect(result[0]?.claim_b.citation.content_hash).toEqual(expect.any(String));
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

    expect(result).toHaveLength(1);
    expect(result[0]?.scope).toBe("intra-material");
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

    await expect(createService(fixture, adapter).detect(OPERATOR, caseId)).resolves.toEqual([]);
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

    expect(result).toEqual([]);
  });

  it("skips a failed extraction batch and records best-effort coverage", async () => {
    const { caseId } = await createCaseWithDocs(fixture, [
      { filename: "alpha.txt", content: "USS Gerald Ford displacement is 100000 tons." },
    ]);
    const adapter = new ScriptedJsonAdapter([new Error("extract failed")]);

    await expect(createService(fixture, adapter).detect(OPERATOR, caseId)).resolves.toEqual([]);
    const event = (await fixture.audit.readAll()).filter((item) => item.action === "contradiction.detect").pop();
    expect(event?.result).toBe("ok");
    expect(event?.detail).toMatchObject({ batches: 1, chunksCovered: 0, chunksTotal: 1, failedBatches: 1 });
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
    const cross = result.find((item) => item.scope === "cross-material");
    const intra = result.find((item) => item.scope === "intra-material");

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

    expect(adapter.inputs.filter((input) => !input.messages[0]?.content.includes("claim_a:"))).toHaveLength(2);
    expect(result).toHaveLength(1);
    expect(result[0]?.claim_a.citation.content_hash).toBe(chunks[0]!.content_hash);
    expect(result[0]?.claim_b.citation.content_hash).toBe(chunks[40]!.content_hash);
    const event = (await fixture.audit.readAll()).filter((item) => item.action === "contradiction.detect").pop();
    expect(event?.detail).toMatchObject({ batches: 2, chunksCovered: 41, chunksTotal: 41, failedBatches: 0 });
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

    expect(result).toEqual([]);
    expect(adapter.inputs.filter((input) => input.messages[0]?.content.includes("claim_a:"))).toHaveLength(0);
  });
});
