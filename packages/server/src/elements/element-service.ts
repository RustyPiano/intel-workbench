import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_PROMPT_BODIES, type PromptStore } from "../admin/prompt-store.js";
import { mapWithConcurrency, splitIntoBatches } from "../analysis/batch-extract.js";
import { mergeElements } from "../analysis/element-merge.js";
import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import { AppError } from "../domain/identity.js";
import type { Chunk, Element, ElementType, Identity } from "../domain/types.js";
import { resolveValidCitations } from "../inquiry/citation.js";
import { generateJson, type LlmDeps } from "../model/structured.js";
import type { MaterialService } from "../materials/material-service.js";
import { shortId } from "../util/hash.js";

/**
 * 要素抽取（产品 spec §5.2 / §8.6，一期"最小可用"）。复用溯源红线管线：
 * OfflineGuard 授权 → 结构化生成 → 每条"提及"必须引用真实 chunk（content_hash
 * 校验，§4.3）；无有效提及的要素丢弃。关系图谱/复杂时间线属二期（§14）。
 */

const ELEMENT_TYPES: readonly ElementType[] = ["person", "org", "location", "event", "equipment", "time"];
const BATCH_CHUNKS = 40;
const CONCURRENCY = 4;
const ELEMENT_EXTRACT_PROMPT = DEFAULT_PROMPT_BODIES["element-extract"];

interface RawMention {
  chunk_id?: unknown;
}
interface RawElement {
  name?: unknown;
  type?: unknown;
  aliases?: unknown;
  mentions?: unknown;
}
interface ExtractOptions {
  signal?: AbortSignal;
  onProgress?: (p: { done: number; total: number }) => void;
}

interface BatchResult {
  elements: Element[];
  chunksCovered: number;
  failed: boolean;
}

function asType(value: unknown): ElementType {
  return typeof value === "string" && (ELEMENT_TYPES as readonly string[]).includes(value) ? (value as ElementType) : "event";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean) : [];
}

export class ElementService {
  constructor(
    private readonly paths: DataPaths,
    private readonly audit: AuditService,
    private readonly cases: CaseService,
    private readonly materials: MaterialService,
    private readonly deps: LlmDeps,
    private readonly promptStore?: PromptStore,
  ) {}

  /** 对专题已加工切块做一次要素抽取，覆盖写 elements.json。 */
  async extract(actor: Identity, caseId: string, opts: ExtractOptions = {}): Promise<Element[]> {
    const manifest = await this.cases.get(actor, caseId);
    const nameById = new Map(manifest.materials.map((m) => [m.id, m.filename]));

    const all = await this.materials.loadCaseChunks(caseId);
    if (all.length === 0) {
      await this.persist(caseId, []);
      await this.audit.append({ user: actor.id, action: "element.extract", object: `case:${caseId}`, caseId, detail: { caseId, count: 0, reason: "无已加工素材" } });
      return [];
    }
    if (!this.deps.adapter || !this.deps.modelEndpoint) {
      throw new AppError(503, "文本 LLM 未配置：要素抽取不可用");
    }

    try {
      const batches = splitIntoBatches(all, BATCH_CHUNKS);
      const results = await mapWithConcurrency(batches, async (chunks): Promise<BatchResult> => {
        // 零外发红线：每个批次出站前先经 OfflineGuard 授权——授权失败必须显式失败，不得当作"失败批次"吞掉。
        await this.deps.guard.authorize(this.deps.modelEndpoint, { user: actor.id, purpose: "text-llm-elements" });
        let raw: Record<string, unknown>;
        try {
          raw = await this.callModel(chunks, opts.signal);
        } catch (e) {
          if (opts.signal?.aborted || e instanceof AppError) throw e;
          // 仅模型/网络/解析失败 → best-effort 跳过该批，其余继续。
          return { elements: [], chunksCovered: 0, failed: true };
        }
        // 接地与构建在 catch 之外：其内部缺陷应当显式抛出，而非被静默记成失败批次。
        const retrievedById = new Map(chunks.map((c) => [c.chunk_id, c]));
        return { elements: this.buildElements(raw, retrievedById, nameById), chunksCovered: chunks.length, failed: false };
      }, {
        concurrency: CONCURRENCY,
        signal: opts.signal,
        onSettled: (done, total) => opts.onProgress?.({ done, total }),
      });
      const elements = mergeElements(results.map((result) => result.elements));
      const chunksCovered = results.reduce((sum, result) => sum + result.chunksCovered, 0);
      const failedBatches = results.filter((result) => result.failed).length;

      await this.persist(caseId, elements);
      await this.audit.append({
        user: actor.id,
        action: "element.extract",
        object: `case:${caseId}`,
        caseId,
        detail: { caseId, count: elements.length, batches: batches.length, chunksCovered, chunksTotal: all.length, failedBatches },
      });
      return elements;
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      // 失败路径记账（审计红线）：抽取出错（含 OfflineGuard 出站拒绝）落 element.extract error
      // 并显式抛出 → 任务落「error」态而非「done+空」（与 contradiction.detect 一致）。
      await this.audit.append({
        user: actor.id,
        action: "element.extract",
        object: `case:${caseId}`,
        result: "error",
        caseId,
        detail: { result: "error", error: e instanceof Error ? e.message : String(e) },
      });
      throw e;
    }
  }

  async get(actor: Identity, caseId: string): Promise<Element[]> {
    await this.cases.get(actor, caseId);
    try {
      return JSON.parse(await readFile(this.elementsFile(caseId), "utf8")) as Element[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  private buildElements(raw: Record<string, unknown>, retrievedById: Map<string, Chunk>, nameById: Map<string, string>): Element[] {
    const rawElements = Array.isArray(raw.elements) ? (raw.elements as RawElement[]) : [];
    const elements: Element[] = [];
    for (const re of rawElements) {
      const name = String(re.name ?? "").trim();
      if (!name) continue;
      const ids = Array.isArray(re.mentions)
        ? (re.mentions as RawMention[]).map((m) => m?.chunk_id).filter((x): x is string => typeof x === "string")
        : [];
      const mentions = resolveValidCitations(ids, retrievedById, nameById);
      if (mentions.length === 0) continue; // 无有效出处 → 丢弃（§4.3）
      elements.push({
        id: shortId("el-"),
        type: asType(re.type),
        name,
        aliases: asStringArray(re.aliases),
        mentions,
        freq: mentions.length,
      });
    }
    return elements;
  }

  private async callModel(chunks: Chunk[], signal?: AbortSignal): Promise<Record<string, unknown>> {
    const context = chunks.map((c) => `[${c.chunk_id}] ${c.text}`).join("\n\n");
    const systemPrompt = this.promptStore ? await this.promptStore.getBody("element-extract") : ELEMENT_EXTRACT_PROMPT;
    const userContent = `素材片段：\n${context}\n\n请只输出 JSON。`;
    // 批次抽取要素 JSON 本身可达数千 token；2000 会截断成不可解析。
    // 同时放宽超时：大专题批次抽取留足余量避免 60s 默认超时误杀。
    // thinking="disabled"：批量抽取关思考，避免推理模型把 token 预算耗在思维链上。
    return generateJson(this.deps.adapter!, systemPrompt, userContent, {
      maxTokens: 12000,
      timeoutMs: 120_000,
      thinking: "disabled",
      signal,
    });
  }

  private elementsFile(caseId: string): string {
    return path.join(this.paths.caseDir(caseId), "elements.json");
  }

  private async persist(caseId: string, elements: Element[]): Promise<void> {
    const file = this.elementsFile(caseId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(elements, null, 2)}\n`, "utf8");
  }
}
