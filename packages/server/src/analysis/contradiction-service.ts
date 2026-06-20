import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_PROMPT_BODIES, type PromptStore } from "../admin/prompt-store.js";
import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import type { Chunk, Citation, Contradiction, Identity } from "../domain/types.js";
import { chunkToCitation, resolveValidCitations } from "../inquiry/citation.js";
import { fitToBudget } from "../inquiry/retrieval.js";
import { readCtxBudgetTokens } from "../model/rag-config.js";
import { generateJson, type LlmDeps } from "../model/structured.js";
import type { MaterialService } from "../materials/material-service.js";
import { shortId } from "../util/hash.js";

const MAX_CHUNKS = 60;
const MAX_PAIRS_PER_CLUSTER = 30;
const EXTRACT_PROMPT = DEFAULT_PROMPT_BODIES["contradiction-extract"];
const JUDGE_PROMPT = DEFAULT_PROMPT_BODIES["contradiction-judge"];

interface RawClaim {
  entity?: unknown;
  attribute?: unknown;
  value?: unknown;
  chunk_id?: unknown;
}

interface GroundedClaim {
  entity: string;
  attribute: string;
  value: string;
  chunk_id: string;
  material_id: string;
  citation: Citation;
  text: string;
}

interface JudgeResult {
  relation: "contradiction" | "agreement" | "unrelated";
  rationale: string;
  certainty?: number;
}

function normalizeKey(entity: string, attribute: string): string {
  return `${entity.toLowerCase().trim()}:${attribute.toLowerCase().trim()}`;
}

function citationKey(citation: Citation): string {
  return `${citation.material_id}:${citation.content_hash}:${citation.snippet}`;
}

function claimText(claim: Pick<GroundedClaim, "entity" | "attribute" | "value">): string {
  return `${claim.entity} ${claim.attribute}: ${claim.value}`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function parseNumeric(value: string): number | null {
  const normalized = value.trim().replace(/,/g, "");
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function numericDistanceBonus(a: string, b: string): number {
  const left = parseNumeric(a);
  const right = parseNumeric(b);
  if (left === null || right === null || left === right) return 0;
  return 0.2 * Math.min(1, Math.abs(left - right) / Math.max(Math.abs(left), Math.abs(right), 1));
}

function asJudgeResult(raw: Record<string, unknown>): JudgeResult {
  const relation = raw.relation === "contradiction" || raw.relation === "agreement" || raw.relation === "unrelated"
    ? raw.relation
    : "unrelated";
  const certainty = typeof raw.certainty === "number" && Number.isFinite(raw.certainty) ? clamp01(raw.certainty) : undefined;
  return {
    relation,
    rationale: typeof raw.rationale === "string" ? raw.rationale : "",
    certainty,
  };
}

export class ContradictionService {
  constructor(
    private readonly paths: DataPaths,
    private readonly audit: AuditService,
    private readonly cases: CaseService,
    private readonly materials: MaterialService,
    private readonly llm: LlmDeps,
    private readonly promptStore?: PromptStore,
  ) {}

  async detect(actor: Identity, caseId: string): Promise<Contradiction[]> {
    try {
      const manifest = await this.cases.get(actor, caseId);
      const nameById = new Map(manifest.materials.map((m) => [m.id, m.filename]));
      const all = await this.materials.loadCaseChunks(caseId);
      if (all.length === 0) {
        await this.persist(caseId, []);
        await this.audit.append({
          user: actor.id,
          action: "contradiction.detect",
          object: `case:${caseId}`,
          caseId,
          detail: { caseId, count: 0, clusters: 0, pairsJudged: 0, reason: "无已加工素材" },
        });
        return [];
      }
      if (!this.llm.adapter || !this.llm.modelEndpoint) throw new Error("文本 LLM 未配置：矛盾检测不可用");

      const budget = readCtxBudgetTokens();
      const { used: chunks } =
        budget !== null ? fitToBudget(all, budget) : { used: all.slice(0, MAX_CHUNKS) };
      if (budget === null && all.length > MAX_CHUNKS) {
        console.warn(`ContradictionService 无预算回退：截到前 ${MAX_CHUNKS}/${all.length} 块（设 MINI_AGENT_CTX_BUDGET_TOKENS 以按预算取材）`);
      }
      const retrievedById = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
      const rawClaims = await this.extractClaims(actor, chunks);
      const claims = this.groundClaims(rawClaims, retrievedById, nameById);
      const clusters = this.clusterClaims(claims);
      const { contradictions, pairsJudged } = await this.judgeClusters(actor, clusters);

      contradictions.sort((a, b) => b.confidence - a.confidence);
      await this.persist(caseId, contradictions);
      await this.audit.append({
        user: actor.id,
        action: "contradiction.detect",
        object: `case:${caseId}`,
        caseId,
        detail: { caseId, count: contradictions.length, clusters: clusters.size, pairsJudged },
      });
      return contradictions;
    } catch (e) {
      await this.audit.append({
        user: actor.id,
        action: "contradiction.detect",
        object: `case:${caseId}`,
        result: "error",
        caseId,
        detail: { result: "error", error: e instanceof Error ? e.message : String(e) },
      });
      return [];
    }
  }

  async get(actor: Identity, caseId: string): Promise<Contradiction[]> {
    await this.cases.get(actor, caseId);
    try {
      return JSON.parse(await readFile(this.contradictionsFile(caseId), "utf8")) as Contradiction[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  private async extractClaims(actor: Identity, chunks: Chunk[]): Promise<RawClaim[]> {
    const context = chunks.map((chunk) => `[${chunk.chunk_id}] ${chunk.text}`).join("\n\n");
    const systemPrompt = this.promptStore ? await this.promptStore.getBody("contradiction-extract") : EXTRACT_PROMPT;
    await this.llm.guard.authorize(this.llm.modelEndpoint, { user: actor.id, purpose: "contradiction-extract" });
    const raw = await generateJson(this.llm.adapter!, systemPrompt, `素材片段：\n${context}\n\n请只输出 JSON。`, { maxTokens: 2500 });
    return Array.isArray(raw.claims) ? (raw.claims as RawClaim[]) : [];
  }

  private groundClaims(rawClaims: RawClaim[], retrievedById: Map<string, Chunk>, nameById: Map<string, string>): GroundedClaim[] {
    const chunkIds = rawClaims.map((claim) => claim.chunk_id).filter((id): id is string => typeof id === "string");
    const validKeys = new Set(resolveValidCitations(chunkIds, retrievedById, nameById).map(citationKey));
    const grounded: GroundedClaim[] = [];
    for (const raw of rawClaims) {
      const entity = typeof raw.entity === "string" ? raw.entity.trim() : "";
      const attribute = typeof raw.attribute === "string" ? raw.attribute.trim() : "";
      const value = typeof raw.value === "string" ? raw.value.trim() : "";
      const chunkId = typeof raw.chunk_id === "string" ? raw.chunk_id : "";
      if (!entity || !attribute || !value || !chunkId) continue;
      const chunk = retrievedById.get(chunkId);
      if (!chunk) continue;
      const citation = chunkToCitation(chunk, nameById.get(chunk.material_id) ?? chunk.material_id);
      if (!validKeys.has(citationKey(citation))) continue;
      grounded.push({
        entity,
        attribute,
        value,
        chunk_id: chunkId,
        material_id: chunk.material_id,
        citation,
        text: claimText({ entity, attribute, value }),
      });
    }
    return grounded;
  }

  private clusterClaims(claims: GroundedClaim[]): Map<string, GroundedClaim[]> {
    const clusters = new Map<string, GroundedClaim[]>();
    for (const claim of claims) {
      const key = normalizeKey(claim.entity, claim.attribute);
      clusters.set(key, [...(clusters.get(key) ?? []), claim]);
    }
    return clusters;
  }

  private async judgeClusters(actor: Identity, clusters: Map<string, GroundedClaim[]>): Promise<{ contradictions: Contradiction[]; pairsJudged: number }> {
    const contradictions: Contradiction[] = [];
    let pairsJudged = 0;
    for (const claims of clusters.values()) {
      let pairs = this.enumeratePairs(claims);
      if (pairs.length > MAX_PAIRS_PER_CLUSTER) {
        console.warn(`ContradictionService capped cluster pairs from ${pairs.length} to ${MAX_PAIRS_PER_CLUSTER}`);
        pairs = pairs.slice(0, MAX_PAIRS_PER_CLUSTER);
      }
      for (const [claimA, claimB] of pairs) {
        const judge = await this.judgePair(actor, claimA, claimB);
        pairsJudged++;
        if (judge.relation !== "contradiction") continue;
        const crossSource = claimA.material_id !== claimB.material_id;
        contradictions.push({
          id: shortId("ct-"),
          entity: claimA.entity,
          attribute: claimA.attribute,
          scope: crossSource ? "cross-material" : "intra-material",
          claim_a: { text: claimA.text, citation: claimA.citation },
          claim_b: { text: claimB.text, citation: claimB.citation },
          relation: "contradiction",
          rationale: judge.rationale,
          confidence: this.confidence(judge.certainty, crossSource, claimA.value, claimB.value),
        });
      }
    }
    return { contradictions, pairsJudged };
  }

  private enumeratePairs(claims: GroundedClaim[]): [GroundedClaim, GroundedClaim][] {
    const pairs: [GroundedClaim, GroundedClaim][] = [];
    for (let i = 0; i < claims.length; i++) {
      for (let j = i + 1; j < claims.length; j++) {
        pairs.push([claims[i]!, claims[j]!]);
      }
    }
    return pairs;
  }

  private async judgePair(actor: Identity, claimA: GroundedClaim, claimB: GroundedClaim): Promise<JudgeResult> {
    const systemPrompt = this.promptStore ? await this.promptStore.getBody("contradiction-judge") : JUDGE_PROMPT;
    await this.llm.guard.authorize(this.llm.modelEndpoint, { user: actor.id, purpose: "contradiction-judge" });
    const raw = await generateJson(
      this.llm.adapter!,
      systemPrompt,
      [
        `claim_a: ${claimA.text}`,
        `claim_b: ${claimB.text}`,
        "请只输出 JSON。",
      ].join("\n"),
      { maxTokens: 800 },
    );
    return asJudgeResult(raw);
  }

  private confidence(certainty: number | undefined, crossSource: boolean, leftValue: string, rightValue: string): number {
    return clamp01(((certainty ?? 0.7) * 0.5) + (crossSource ? 0.3 : 0) + numericDistanceBonus(leftValue, rightValue));
  }

  private contradictionsFile(caseId: string): string {
    return path.join(this.paths.caseDir(caseId), "contradictions.json");
  }

  private async persist(caseId: string, contradictions: Contradiction[]): Promise<void> {
    const file = this.contradictionsFile(caseId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(contradictions, null, 2)}\n`, "utf8");
  }
}
