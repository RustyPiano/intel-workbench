import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createModelAdapter, type ModelAdapter } from "mini-agent";

import { DEFAULT_PROMPT_BODIES } from "../src/admin/prompt-store.js";
import { AuditService, type AppendInput } from "../src/audit/audit-service.js";
import { resolveDataPaths } from "../src/data/paths.js";
import type { Chunk } from "../src/domain/types.js";
import { rewriteForRetrieval, type RewriteMode } from "../src/inquiry/query-rewrite.js";
import { indexText, retrieveHybrid, rerankTopK } from "../src/inquiry/retrieval.js";
import { chunkText, normalize } from "../src/materials/material-service.js";
import { readModelConfig } from "../src/model/model-config.js";
import { buildSlots } from "../src/model/mock-slots.js";
import { readSlotConfigs, slotAllowlistHosts } from "../src/model/slot-config.js";
import type { EmbeddingAdapter } from "../src/model/slots.js";
import type { LlmDeps } from "../src/model/structured.js";
import { OfflineGuard } from "../src/security/offline-guard.js";
import { aggregateMetrics, type MetricAverages, type QueryRanking } from "./metrics.js";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.join(EVAL_DIR, "corpus");
const RESULTS_DIR = path.join(EVAL_DIR, "results");
const EMBED_BATCH = 32;
const LLM_CONCURRENCY = 8;

type Variant = "baseline" | "cr" | "qrewrite" | "hyde";

interface GoldQuery {
  qid: string;
  query: string;
  relevant: string[];
  note?: string;
}

interface MetricSummary {
  recallAt5: number;
  recallAt10: number;
  mrrAt10: number;
  ndcgAt10: number;
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function assertFilePart(value: string, label: string): void {
  if (!value || /[/\\\0]/.test(value)) throw new Error(`${label} must be a non-empty filename part`);
}

function parseVariant(value: string): Variant {
  if (value === "baseline" || value === "cr" || value === "qrewrite" || value === "hyde") return value;
  throw new Error(`Unsupported --variant=${value}. Expected baseline, cr, qrewrite, or hyde.`);
}

async function auditBestEffort(audit: AuditService, input: AppendInput): Promise<void> {
  try {
    await audit.append(input);
  } catch (error) {
    console.error(`audit failed for ${input.action}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function pooledMap<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function loadCorpus(): Promise<{ chunks: Chunk[]; docTexts: Map<string, string>; docs: number; queries: GoldQuery[] }> {
  const docsDir = path.join(CORPUS_DIR, "docs");
  const entries = (await readdir(docsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
    .sort((a, b) => a.name.localeCompare(b.name));

  const chunks: Chunk[] = [];
  const docTexts = new Map<string, string>();
  for (const entry of entries) {
    const raw = await readFile(path.join(docsDir, entry.name), "utf8");
    const text = normalize(raw);
    const stem = path.basename(entry.name, ".txt");
    docTexts.set(stem, text);
    chunks.push(...chunkText(stem, text));
  }

  const queryLines = (await readFile(path.join(CORPUS_DIR, "queries.jsonl"), "utf8")).split("\n").filter((line) => line.trim());
  const queries = queryLines.map((line, i): GoldQuery => {
    const parsed = JSON.parse(line) as Partial<GoldQuery>;
    if (typeof parsed.qid !== "string" || typeof parsed.query !== "string" || !Array.isArray(parsed.relevant)) {
      throw new Error(`Invalid queries.jsonl row ${i + 1}`);
    }
    return {
      qid: parsed.qid,
      query: parsed.query,
      relevant: parsed.relevant.filter((id): id is string => typeof id === "string"),
      note: typeof parsed.note === "string" ? parsed.note : undefined,
    };
  });

  if (chunks.length === 0) throw new Error("Corpus has no chunks. Run npm run eval:gen first.");
  if (queries.length === 0) throw new Error("Corpus has no queries. Run npm run eval:gen first.");

  // 漂移防护：gold label 必须对得上重建出的 chunk_id（切块器若变更则金标失效→假性低召回）。
  const chunkIds = new Set(chunks.map((c) => c.chunk_id));
  const missing = queries.flatMap((q) => q.relevant.filter((id) => !chunkIds.has(id)).map((id) => `${q.qid}:${id}`));
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} 个 gold chunk_id 在重建语料中不存在（切块器漂移？请重跑 npm run eval:gen）。示例：${missing.slice(0, 5).join(", ")}`,
    );
  }

  return { chunks, docTexts, docs: entries.length, queries };
}

async function embedWithGuard(
  embed: EmbeddingAdapter,
  endpoint: string,
  guard: OfflineGuard,
  texts: string[],
  purpose: "embed-eval" | "embed-query",
): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    if (batch.length === 0) continue;
    await guard.authorize(endpoint, { user: "eval", purpose });
    out.push(...(await embed.embed(batch)));
  }
  return out;
}

function selectedMetrics(metrics: MetricAverages): MetricSummary {
  return {
    recallAt5: metrics.recallAt5 ?? 0,
    recallAt10: metrics.recallAt10 ?? 0,
    mrrAt10: metrics.mrrAt10 ?? 0,
    ndcgAt10: metrics.ndcgAt10 ?? 0,
  };
}

function fmt(n: number): string {
  return n.toFixed(4);
}

function printTable(rows: { variant: string; metrics: MetricSummary }[]): void {
  console.log(["variant", "Recall@5", "Recall@10", "MRR@10", "nDCG@10"].join("\t"));
  for (const row of rows) {
    console.log([
      row.variant,
      fmt(row.metrics.recallAt5),
      fmt(row.metrics.recallAt10),
      fmt(row.metrics.mrrAt10),
      fmt(row.metrics.ndcgAt10),
    ].join("\t"));
  }
}

async function appendSummary(stamp: string, variant: string, queryCount: number, chunkCount: number, hybrid: MetricSummary, rerank?: MetricSummary): Promise<void> {
  await mkdir(RESULTS_DIR, { recursive: true });
  const summary = path.join(RESULTS_DIR, "summary.md");
  try {
    await readFile(summary, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(
      summary,
      "| stamp | variant | queries | chunks | hybrid R@5 | hybrid R@10 | hybrid MRR@10 | hybrid nDCG@10 | rerank R@5 | rerank R@10 | rerank MRR@10 | rerank nDCG@10 |\n" +
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n",
      "utf8",
    );
  }
  const rerankCells = rerank
    ? [fmt(rerank.recallAt5), fmt(rerank.recallAt10), fmt(rerank.mrrAt10), fmt(rerank.ndcgAt10)]
    : ["", "", "", ""];
  await appendFile(
    summary,
    `| ${stamp} | ${variant} | ${queryCount} | ${chunkCount} | ${fmt(hybrid.recallAt5)} | ${fmt(hybrid.recallAt10)} | ${fmt(hybrid.mrrAt10)} | ${fmt(hybrid.ndcgAt10)} | ${rerankCells.join(" | ")} |\n`,
    "utf8",
  );
}

function buildTextLlm(): { adapter: ModelAdapter; endpoint: string; host: string } {
  const config = readModelConfig();
  if (!config.configured || !config.host) {
    throw new Error("Text LLM is not configured. Source dev.env.sh and set MINI_AGENT_MODEL, MINI_AGENT_BASE_URL, and MINI_AGENT_API_KEY before running this eval variant.");
  }
  return {
    adapter: createModelAdapter({ provider: config.provider, model: config.model, baseURL: config.baseURL, apiKey: config.apiKey }),
    endpoint: config.baseURL,
    host: config.host,
  };
}

async function attachChunkContext(adapter: ModelAdapter, chunks: Chunk[], docTexts: Map<string, string>): Promise<void> {
  await pooledMap(chunks, LLM_CONCURRENCY, async (chunk) => {
    const result = await adapter.generate({
      systemPrompt: DEFAULT_PROMPT_BODIES["chunk-context"],
      messages: [{ role: "user", content: `全文：\n${docTexts.get(chunk.material_id) ?? chunk.text}\n\n片段：\n${chunk.text}` }],
      tools: [],
      temperature: 0,
      maxTokens: 120,
    });
    chunk.context = result.message.content.trim();
  });
}

async function main(): Promise<void> {
  const variantArg = argValue("variant") ?? "baseline";
  const stamp = argValue("stamp") ?? new Date().toISOString();
  assertFilePart(variantArg, "variant");
  assertFilePart(stamp, "stamp");
  const variant = parseVariant(variantArg);

  const auditRoot = await mkdtemp(path.join(os.tmpdir(), "mini-agent-eval-"));
  const audit = new AuditService(resolveDataPaths(auditRoot));
  await auditBestEffort(audit, { user: "eval", action: "eval.run.start", object: `eval:${variant}`, detail: { stamp, variant } });

  try {
    const configs = readSlotConfigs();
    const slots = buildSlots(false, configs);
    if (!slots.embed) throw new Error("Embedding slot is not configured. Source dev.env.sh and set MINI_AGENT_EMBED_* before running eval.");
    const textLlm = variant === "baseline" ? undefined : buildTextLlm();
    const guardHosts = textLlm ? [...new Set([...slotAllowlistHosts(configs), textLlm.host])] : slotAllowlistHosts(configs);
    const guard = new OfflineGuard(guardHosts, audit);
    const { chunks, docTexts, docs, queries } = await loadCorpus();

    if (variant === "cr" && textLlm) {
      await guard.authorize(textLlm.endpoint, { user: "eval", purpose: "corpus-context" });
      await attachChunkContext(textLlm.adapter, chunks, docTexts);
    }

    const vectors = await embedWithGuard(slots.embed, configs.embed.baseURL, guard, variant === "cr" ? chunks.map(indexText) : chunks.map((chunk) => chunk.text), "embed-eval");
    if (vectors.length !== chunks.length) throw new Error(`Embedding count mismatch: expected ${chunks.length}, got ${vectors.length}`);
    const byId = new Map<string, Float32Array>();
    chunks.forEach((chunk, i) => byId.set(chunk.chunk_id, vectors[i]));

    const rewriteMode: RewriteMode | null = variant === "qrewrite" ? "rewrite" : variant === "hyde" ? "hyde" : null;
    const llmDeps: LlmDeps | null = textLlm ? { adapter: textLlm.adapter, guard, modelEndpoint: textLlm.endpoint } : null;
    if (rewriteMode && textLlm) {
      await guard.authorize(textLlm.endpoint, { user: "eval", purpose: "query-rewrite" });
    }

    const hybridRows: QueryRanking[] = [];
    const rerankRows: QueryRanking[] = [];
    const queryResults = [];
    let rewriteFallbacks = 0;

    for (const query of queries) {
      let retrievalQuery = query.query;
      if (rewriteMode && llmDeps) {
        try {
          retrievalQuery = await rewriteForRetrieval(
            llmDeps,
            "eval",
            query.query,
            rewriteMode,
            DEFAULT_PROMPT_BODIES[rewriteMode === "hyde" ? "query-hyde" : "query-rewrite"],
          );
        } catch {
          rewriteFallbacks++;
        }
      }

      const [queryVec] = await embedWithGuard(slots.embed, configs.embed.baseURL, guard, [retrievalQuery], "embed-query");
      const hybrid = retrieveHybrid(retrievalQuery, chunks, queryVec, byId, 10);
      const hybridRanked = hybrid.map((chunk) => chunk.chunk_id);
      hybridRows.push({ ranked: hybridRanked, relevant: query.relevant });

      let reranked: string[] | undefined;
      if (slots.rerank && configs.rerank.baseURL && hybrid.length > 0) {
        await guard.authorize(configs.rerank.baseURL, { user: "eval", purpose: "rerank-query" });
        reranked = (await rerankTopK(retrievalQuery, hybrid, slots.rerank, 10)).map((chunk) => chunk.chunk_id);
        rerankRows.push({ ranked: reranked, relevant: query.relevant });
      }

      queryResults.push({ ...query, hybrid: hybridRanked, ...(reranked ? { rerank: reranked } : {}) });
    }

    const hybridMetrics = selectedMetrics(aggregateMetrics(hybridRows, [5, 10]));
    const rerankMetrics = rerankRows.length > 0 ? selectedMetrics(aggregateMetrics(rerankRows, [5, 10])) : undefined;
    printTable([{ variant: "hybrid", metrics: hybridMetrics }, ...(rerankMetrics ? [{ variant: "rerank", metrics: rerankMetrics }] : [])]);
    if (rewriteMode) {
      console.log(`${variant} raw-query fallbacks: ${rewriteFallbacks}/${queries.length}`);
    }

    await mkdir(RESULTS_DIR, { recursive: true });
    const resultFile = path.join(RESULTS_DIR, `${stamp}-${variant}.json`);
    await writeFile(
      resultFile,
      `${JSON.stringify({ stamp, variant, docs, chunks: chunks.length, queries: queryResults.length, metrics: { hybrid: hybridMetrics, ...(rerankMetrics ? { rerank: rerankMetrics } : {}) }, queryResults }, null, 2)}\n`,
      "utf8",
    );
    await appendSummary(stamp, variant, queryResults.length, chunks.length, hybridMetrics, rerankMetrics);
    await auditBestEffort(audit, {
      user: "eval",
      action: "eval.run.complete",
      object: `eval:${variant}`,
      detail: { stamp, variant, docs, chunks: chunks.length, queries: queryResults.length, resultFile },
    });
  } catch (error) {
    await auditBestEffort(audit, {
      user: "eval",
      action: "eval.run.error",
      object: `eval:${variant}`,
      result: "error",
      detail: { stamp, variant, error: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
