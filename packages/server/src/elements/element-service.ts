import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_PROMPT_BODIES, type PromptStore } from "../admin/prompt-store.js";
import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import { AppError } from "../domain/identity.js";
import type { Chunk, Element, ElementType, Identity } from "../domain/types.js";
import { resolveValidCitations } from "../inquiry/citation.js";
import { fitToBudget } from "../inquiry/retrieval.js";
import { readCtxBudgetTokens } from "../model/rag-config.js";
import { generateJson, type LlmDeps } from "../model/structured.js";
import type { MaterialService } from "../materials/material-service.js";
import { shortId } from "../util/hash.js";

/**
 * 要素抽取（产品 spec §5.2 / §8.6，一期"最小可用"）。复用溯源红线管线：
 * OfflineGuard 授权 → 结构化生成 → 每条"提及"必须引用真实 chunk（content_hash
 * 校验，§4.3）；无有效提及的要素丢弃。关系图谱/复杂时间线属二期（§14）。
 */

const ELEMENT_TYPES: readonly ElementType[] = ["person", "org", "location", "event", "equipment", "time"];
const MAX_CHUNKS = 60;
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
  async extract(actor: Identity, caseId: string): Promise<Element[]> {
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

    // token 预算路由取代静默截断（§5.1）：配置预算则按预算贪心取材，否则退一期 MAX_CHUNKS。
    const budget = readCtxBudgetTokens();
    const { used: chunks, truncated } =
      budget !== null ? fitToBudget(all, budget) : { used: all.slice(0, MAX_CHUNKS), truncated: all.length > MAX_CHUNKS };
    // 零外发红线：出站前先经 OfflineGuard 授权。
    await this.deps.guard.authorize(this.deps.modelEndpoint, { user: actor.id, purpose: "text-llm-elements" });

    const raw = await this.callModel(chunks);
    const retrievedById = new Map(chunks.map((c) => [c.chunk_id, c]));
    const elements = this.buildElements(raw, retrievedById, nameById);

    await this.persist(caseId, elements);
    await this.audit.append({
      user: actor.id,
      action: "element.extract",
      object: `case:${caseId}`,
      caseId,
      detail: { caseId, count: elements.length, chunks: chunks.length, truncated },
    });
    return elements;
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

  private async callModel(chunks: Chunk[]): Promise<Record<string, unknown>> {
    const context = chunks.map((c) => `[${c.chunk_id}] ${c.text}`).join("\n\n");
    const systemPrompt = this.promptStore ? await this.promptStore.getBody("element-extract") : ELEMENT_EXTRACT_PROMPT;
    const userContent = `素材片段：\n${context}\n\n请只输出 JSON。`;
    return generateJson(this.deps.adapter!, systemPrompt, userContent, { maxTokens: 2000 });
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
