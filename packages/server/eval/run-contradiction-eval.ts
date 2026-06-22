import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createModelAdapter, type ModelAdapter } from "mini-agent";

import { ContradictionService } from "../src/analysis/contradiction-service.js";
import { AuditService } from "../src/audit/audit-service.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths } from "../src/data/paths.js";
import type { Chunk, Contradiction, Identity } from "../src/domain/types.js";
import { MaterialService } from "../src/materials/material-service.js";
import { readModelConfig } from "../src/model/model-config.js";
import { parseJsonOutput, type LlmDeps } from "../src/model/structured.js";
import { OfflineGuard } from "../src/security/offline-guard.js";
import { contradictionPRF, type PairPrf } from "./metrics.js";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONTRADICTIONS_DIR = path.join(EVAL_DIR, "contradictions");
const CORPUS_PATH = path.join(CONTRADICTIONS_DIR, "corpus.json");
const RESULTS_DIR = path.join(CONTRADICTIONS_DIR, "results");

const ACTOR: Identity = { id: "eval", name: "eval", role: "operator", clearance: "internal" };

interface CorpusChunk {
  chunk_id: string;
  material_id: string;
  text: string;
}

interface Corpus {
  chunks: CorpusChunk[];
  gold: [string, string][];
}

interface VariantResult {
  variant: string;
  predictedPairs: [string, string][];
  metrics?: PairPrf;
  error?: string;
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function assertFilePart(value: string, label: string): void {
  if (!value || /[/\\\0]/.test(value)) throw new Error(`${label} must be a non-empty filename part`);
}

function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isPair(value: unknown): value is [string, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string" && value[0] !== value[1];
}

async function loadCorpus(): Promise<{ corpus: Corpus; chunks: Chunk[]; nameById: Map<string, string>; chunkIdByHash: Map<string, string> }> {
  const raw = JSON.parse(await readFile(CORPUS_PATH, "utf8")) as Partial<Corpus>;
  if (!Array.isArray(raw.chunks) || !Array.isArray(raw.gold)) throw new Error("Invalid contradiction corpus shape.");

  const chunks: Chunk[] = raw.chunks.map((item, index) => {
    if (typeof item?.chunk_id !== "string" || typeof item.material_id !== "string" || typeof item.text !== "string") {
      throw new Error(`Invalid corpus chunk at index ${index}.`);
    }
    return {
      chunk_id: item.chunk_id,
      material_id: item.material_id,
      modality: "doc",
      locator: {},
      text: item.text,
      content_hash: contentHash(item.text),
    };
  });
  if (chunks.length === 0) throw new Error("Contradiction corpus has no chunks.");

  const gold = raw.gold.filter(isPair);
  if (gold.length !== raw.gold.length) throw new Error("Invalid gold pair in contradiction corpus.");
  const chunkIds = new Set(chunks.map((chunk) => chunk.chunk_id));
  const missingGold = gold.flatMap(([a, b]) => [a, b].filter((id) => !chunkIds.has(id)));
  if (missingGold.length > 0) throw new Error(`Gold pairs reference missing chunks: ${missingGold.join(", ")}`);

  const nameById = new Map([...new Set(chunks.map((chunk) => chunk.material_id))].map((id) => [id, id]));
  const chunkIdByHash = new Map(chunks.map((chunk) => [chunk.content_hash, chunk.chunk_id]));
  return { corpus: { chunks: raw.chunks, gold }, chunks, nameById, chunkIdByHash };
}

function buildTextLlm(): { adapter: ModelAdapter; endpoint: string; host: string } {
  const config = readModelConfig();
  if (!config.configured || !config.host) {
    throw new Error("Text LLM is not configured. Source dev.env.sh and set MINI_AGENT_MODEL, MINI_AGENT_BASE_URL, and MINI_AGENT_API_KEY before running this eval.");
  }
  return {
    adapter: createModelAdapter({ provider: config.provider, model: config.model, baseURL: config.baseURL, apiKey: config.apiKey }),
    endpoint: config.baseURL,
    host: config.host,
  };
}

function pairsFromContradictions(contradictions: Contradiction[], chunkIdByHash: Map<string, string>): [string, string][] {
  const pairs: [string, string][] = [];
  for (const contradiction of contradictions) {
    const a = chunkIdByHash.get(contradiction.claim_a.citation.content_hash);
    const b = chunkIdByHash.get(contradiction.claim_b.citation.content_hash);
    if (a && b && a !== b) pairs.push([a, b]);
  }
  return pairs;
}

async function runAnchored(
  service: ContradictionService,
  chunks: Chunk[],
  nameById: Map<string, string>,
  chunkIdByHash: Map<string, string>,
): Promise<[string, string][]> {
  const contradictions = await service.detectFromChunks(ACTOR, chunks, nameById);
  return pairsFromContradictions(contradictions, chunkIdByHash);
}

async function runDirectBaseline(adapter: ModelAdapter, guard: OfflineGuard, endpoint: string, chunks: Chunk[]): Promise<[string, string][]> {
  await guard.authorize(endpoint, { user: ACTOR.id, purpose: "contradiction-baseline" });
  const result = await adapter.generate({
    systemPrompt: [
      "你是离线情报评测基线模型。找出材料片段之间的直接矛盾。",
      "只有同一实体、同一属性、取值冲突时才列为矛盾；一致、互补或无关信息不要列入。",
      "只输出 JSON，格式为 {\"pairs\":[[\"chunk_id\",\"chunk_id\"]]}。",
    ].join("\n"),
    messages: [{ role: "user", content: chunks.map((chunk) => `[${chunk.chunk_id}] ${chunk.text}`).join("\n") }],
    tools: [],
    temperature: 0,
    maxTokens: 2400,
  });
  const parsed = parseJsonOutput(result.message.content);
  return Array.isArray(parsed.pairs) ? parsed.pairs.filter(isPair) : [];
}

async function runVariant(variant: string, gold: [string, string][], fn: () => Promise<[string, string][]>): Promise<VariantResult> {
  try {
    const predictedPairs = await fn();
    return { variant, predictedPairs, metrics: contradictionPRF(predictedPairs, gold) };
  } catch (error) {
    return { variant, predictedPairs: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function fmt(value: number): string {
  return value.toFixed(4);
}

function printTable(results: VariantResult[]): void {
  console.log(["variant", "precision", "recall", "f1", "tp", "fp", "fn"].join("\t"));
  for (const result of results) {
    if (!result.metrics) {
      console.log([result.variant, "ERROR", "ERROR", "ERROR", "", "", ""].join("\t"));
      continue;
    }
    console.log([
      result.variant,
      fmt(result.metrics.precision),
      fmt(result.metrics.recall),
      fmt(result.metrics.f1),
      String(result.metrics.tp),
      String(result.metrics.fp),
      String(result.metrics.fn),
    ].join("\t"));
  }
}

async function main(): Promise<void> {
  const stamp = argValue("stamp") ?? new Date().toISOString().replace(/:/g, "-");
  assertFilePart(stamp, "stamp");

  const { corpus, chunks, nameById, chunkIdByHash } = await loadCorpus();
  const textLlm = buildTextLlm();
  const auditRoot = await mkdtemp(path.join(os.tmpdir(), "mini-agent-contradiction-eval-"));
  const paths = resolveDataPaths(auditRoot);
  const audit = new AuditService(paths);
  const guard = new OfflineGuard([textLlm.host], audit);
  const cases = new CaseService(paths, audit, false);
  const materials = new MaterialService(paths, audit, cases);
  const llm: LlmDeps = { adapter: textLlm.adapter, guard, modelEndpoint: textLlm.endpoint };
  const service = new ContradictionService(paths, audit, cases, materials, llm);

  // 思考分流对照：锚定流水线的成对 NLI 判定分别开/关思考，量化"在难判定处开思考"是否真有增益。
  process.env.MINI_AGENT_CONTRADICTION_JUDGE_THINKING = "enabled";
  const anchoredThink = await runVariant("anchored-think", corpus.gold, () => runAnchored(service, chunks, nameById, chunkIdByHash));
  process.env.MINI_AGENT_CONTRADICTION_JUDGE_THINKING = "disabled";
  const anchoredNoThink = await runVariant("anchored-nothink", corpus.gold, () => runAnchored(service, chunks, nameById, chunkIdByHash));
  delete process.env.MINI_AGENT_CONTRADICTION_JUDGE_THINKING;
  const results = [
    anchoredThink,
    anchoredNoThink,
    await runVariant("llm-direct", corpus.gold, () => runDirectBaseline(textLlm.adapter, guard, textLlm.endpoint, chunks)),
  ];

  printTable(results);
  await mkdir(RESULTS_DIR, { recursive: true });
  const resultFile = path.join(RESULTS_DIR, `${stamp}.json`);
  await writeFile(
    resultFile,
    `${JSON.stringify({ stamp, chunks: chunks.length, gold: corpus.gold, results }, null, 2)}\n`,
    "utf8",
  );
  console.log(`Wrote ${resultFile}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
