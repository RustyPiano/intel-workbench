import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createModelAdapter, type ModelAdapter } from "mini-agent";

import { AuditService, type AppendInput } from "../src/audit/audit-service.js";
import { resolveDataPaths } from "../src/data/paths.js";
import type { Chunk } from "../src/domain/types.js";
import { chunkText, normalize } from "../src/materials/material-service.js";
import { readModelConfig } from "../src/model/model-config.js";
import { parseJsonOutput } from "../src/model/structured.js";
import { OfflineGuard } from "../src/security/offline-guard.js";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.join(EVAL_DIR, "corpus");
const DOCS_DIR = path.join(CORPUS_DIR, "docs");
const QUERIES_PATH = path.join(CORPUS_DIR, "queries.jsonl");
const TARGET_DOCS = 45;
const TARGET_QUERIES = 100;
const CONCURRENCY = 8;

const DOC_SYSTEM = "你为离线情报分析系统生成完全虚构的中文测试语料。只输出正文，不要任何解释、标题或前后缀。";
const Q_SYSTEM = "你为 RAG 检索评测生成中文问题。问题必须只能由给定片段回答。只输出 JSON。";

interface CorpusQuestion {
  qid: string;
  query: string;
  relevant: string[];
  note: "auto";
}

function stemOf(i: number): string {
  return `doc-${String(i + 1).padStart(3, "0")}`;
}

async function auditBestEffort(audit: AuditService, input: AppendInput): Promise<void> {
  try {
    await audit.append(input);
  } catch (error) {
    console.error(`audit failed for ${input.action}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 并发池：保序执行，最多 limit 个在飞。 */
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

async function generateText(adapter: ModelAdapter, systemPrompt: string, userContent: string, maxTokens: number): Promise<string> {
  const result = await adapter.generate({ systemPrompt, messages: [{ role: "user", content: userContent }], tools: [], temperature: 0.7, maxTokens });
  return result.message.content.trim();
}

async function generateQuestion(adapter: ModelAdapter, chunk: Chunk): Promise<string | null> {
  const result = await adapter.generate({
    systemPrompt: Q_SYSTEM,
    messages: [
      {
        role: "user",
        content: `根据下面片段写 1 个中文检索问题。要求：① 答案只能由该片段支持；② 用与原文明显不同的措辞（同义改写/概括/追问），避免照抄片段词句；③ 像分析员的自然提问；④ 不引用片段编号、不问片段外常识。输出格式：{"question":"..."}\n\n片段：\n${chunk.text}`,
      },
    ],
    tools: [],
    temperature: 0.7,
    maxTokens: 600,
  });
  const obj = parseJsonOutput(result.message.content);
  const q = obj.question;
  return typeof q === "string" && q.trim().length > 0 ? q.trim() : null;
}

/** 并发补齐缺失的 doc 文件（盘上已有的复用→可续跑），再读全部确定性切块。 */
async function buildDocs(adapter: ModelAdapter): Promise<Chunk[]> {
  const missing: number[] = [];
  for (let i = 0; i < TARGET_DOCS; i++) {
    try {
      await readFile(path.join(DOCS_DIR, `${stemOf(i)}.txt`), "utf8");
    } catch {
      missing.push(i);
    }
  }
  await pooledMap(missing, CONCURRENCY, async (i) => {
    const text = await generateText(
      adapter,
      DOC_SYSTEM,
      `写 1 篇现实感较强但完全虚构的中文情报素材（类型择一：态势通报/截获通信/巡逻简报/物流异常/口岸记录/舆情摘编）。1500-2200 个汉字，分 6-9 个自然段，段落之间用空行分隔，每段聚焦一个不同细节（时间、地点、装备、人物代号、数量、研判结论等）便于按段检索。这是第 ${i + 1} 篇，使用与众不同的区域名/代号/编号以增加干扰区分度。不要出现真实个人敏感信息。`,
      4_000,
    );
    if (text.length < 200) throw new Error(`第 ${i + 1} 篇生成过短（${text.length} 字），疑似失败。`);
    await writeFile(path.join(DOCS_DIR, `${stemOf(i)}.txt`), `${text}\n`, "utf8");
  });

  const chunks: Chunk[] = [];
  for (let i = 0; i < TARGET_DOCS; i++) {
    const clean = (await readFile(path.join(DOCS_DIR, `${stemOf(i)}.txt`), "utf8")).trim();
    chunks.push(...chunkText(stemOf(i), normalize(clean)));
  }
  return chunks;
}

/** 可续跑：复用已有 queries.jsonl，跳过已出题 chunk，并发补到 TARGET_QUERIES。 */
async function buildQueries(adapter: ModelAdapter, chunks: Chunk[]): Promise<number> {
  let existing: CorpusQuestion[] = [];
  try {
    existing = (await readFile(QUERIES_PATH, "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as CorpusQuestion);
  } catch {
    existing = [];
  }
  const queried = new Set(existing.flatMap((q) => q.relevant));
  const need = TARGET_QUERIES - existing.length;
  if (need <= 0) return existing.length;

  const targets = chunks.filter((c) => !queried.has(c.chunk_id)).slice(0, need);
  const generated = await pooledMap(targets, CONCURRENCY, async (chunk) => ({ chunk, query: await generateQuestion(adapter, chunk) }));

  let qCount = existing.length;
  for (const { chunk, query } of generated) {
    if (!query) continue;
    qCount++;
    const record: CorpusQuestion = { qid: `q-${String(qCount).padStart(3, "0")}`, query, relevant: [chunk.chunk_id], note: "auto" };
    await appendFile(QUERIES_PATH, `${JSON.stringify(record)}\n`, "utf8");
  }
  return qCount;
}

async function main(): Promise<void> {
  const auditRoot = await mkdtemp(path.join(os.tmpdir(), "mini-agent-eval-gen-"));
  const audit = new AuditService(resolveDataPaths(auditRoot));
  await auditBestEffort(audit, { user: "eval-gen", action: "eval.corpus_gen.start", object: "eval:corpus", detail: { targetDocs: TARGET_DOCS, targetQueries: TARGET_QUERIES } });

  try {
    const config = readModelConfig();
    if (!config.configured || !config.host) {
      throw new Error("Text LLM is not configured. Source dev.env.sh and set MINI_AGENT_MODEL, MINI_AGENT_BASE_URL, and MINI_AGENT_API_KEY before generating corpus.");
    }

    const adapter = createModelAdapter({ provider: config.provider, model: config.model, baseURL: config.baseURL, apiKey: config.apiKey });
    // dev 评测脚本：单端点、单次授权后并发生成（非产品出站路径；并发授权会争用临时审计哈希链）。
    const guard = new OfflineGuard([config.host], audit);
    await guard.authorize(config.baseURL, { user: "eval-gen", purpose: "corpus-gen" });

    await mkdir(DOCS_DIR, { recursive: true }); // 不清空：可续跑

    const chunks = await buildDocs(adapter);
    if (chunks.length === 0) throw new Error("Generated documents produced no chunks.");
    const docCount = new Set(chunks.map((c) => c.material_id)).size;

    const qCount = await buildQueries(adapter, chunks);
    if (qCount === 0) throw new Error("Model returned no questions for generated chunks.");
    if (qCount < TARGET_QUERIES) {
      console.warn(`只生成 ${qCount}/${TARGET_QUERIES} 条 query（chunk 偏少或模型产出不足），可重跑或人工补充。`);
    }

    await auditBestEffort(audit, { user: "eval-gen", action: "eval.corpus_gen.complete", object: "eval:corpus", detail: { docs: docCount, chunks: chunks.length, queries: qCount } });
    console.log(`Generated ${docCount} docs, ${chunks.length} chunks, ${qCount} queries in ${CORPUS_DIR}`);
  } catch (error) {
    await auditBestEffort(audit, { user: "eval-gen", action: "eval.corpus_gen.error", object: "eval:corpus", result: "error", detail: { error: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
