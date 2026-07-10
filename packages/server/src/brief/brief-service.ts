import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { ContradictionService } from "../analysis/contradiction-service.js";
import type { ElementGraphService } from "../analysis/element-graph-service.js";
import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import type {
  CaseManifest,
  Chunk,
  Citation,
  ContradictionAcknowledgementStatus,
  ElementType,
  Identity,
  Modality,
  TimelinePoint,
} from "../domain/types.js";
import type { ElementService } from "../elements/element-service.js";
import { findingsFilePath } from "../finding/finding-store.js";
import type { FindingService } from "../finding/finding-service.js";
import type { AutoInquiryProgress, AutoInquiryService } from "../inquiry/auto-inquiry-service.js";
import { chunkToCitation } from "../inquiry/citation.js";
import { fuzzyLocate } from "../inquiry/intel-harness.js";
import type { MaterialService } from "../materials/material-service.js";
import { readSlotConfigs, useMockMedia, type SlotConfigs } from "../model/slot-config.js";
import { generateJson, type LlmDeps } from "../model/structured.js";
import { computeCoverage, type ReportCoverage } from "../report/coverage.js";
import type { QuestionSuggestion, SuggestionService } from "../suggestion/suggestion-service.js";
import type { TaskRunSnapshot, TaskService } from "../task/task-service.js";
import { writeFileAtomic } from "../util/atomic.js";
import { sha256 } from "../util/hash.js";

/**
 * 研判简报（阶段三 M2 / 计划 D1·D5）。把一份案卷聚合成一屏可核验的「专题落地视图」：
 * 案情概览（LLM 生成、逐句绑定原文引用）、素材/加工统计、时间线骨架、关键实体、
 * 未处置矛盾、待核问题——各板块只读既有落盘产物（复用 element/contradiction/finding/
 * suggestion/task 服务），不新建产物类型。
 *
 * 缓存与陈旧性（D5）：昂贵的部分（LLM 概览段 + 派生快照）落 `cases/<id>/brief.json`。
 * 以轻量指纹（素材签名 + 各产物文件 size/mtime）判定 stale；指纹一致且未强制刷新则命中
 * 缓存直接返回，否则重算并原子写回。任务阶段条 / autopilot 开关等实时字段每次现算叠加，
 * 不进指纹（避免确认检查点这类操作误触发 LLM 重跑）。
 *
 * 防编造（计划 §4 风险条）：概览每句必须携带 chunk_id + 逐字 quote；服务端逐句校验
 * quote 是原文子串且 sha256(chunk.text)===content_hash（复用 citation 工具），校验不过的
 * 句子丢弃不渲染。LLM 未配置 / 出站被拒 / 无已加工素材 → 降级为纯统计简报（概览为空、
 * degraded=true），页面明示。
 */

const MAX_OVERVIEW_SENTENCES = 6;
const MAX_OVERVIEW_CONTEXT_CHARS = 8000;
const TIMELINE_TOP = 8;
const ENTITIES_TOP = 8;
const CONTRADICTIONS_TOP = 8;
const OPEN_QUESTIONS_TOP = 6;

const OVERVIEW_SYSTEM_PROMPT = [
  "你是情报研判助手。基于给定的、带编号的素材片段，写一段简洁的案情概览（3 到 6 句）。",
  "严格要求：",
  "- 每句话必须完全基于某一个素材片段，不得编造、不得外推、不得引入片段之外的信息。",
  "- 每句话必须给出其依据的 chunk_id，以及一段从该片段原文逐字复制的引文（quote）；引文必须是该片段文本的连续子串。",
  '- 只输出 JSON：{"sentences":[{"text":"概览句","chunk_id":"片段编号","quote":"逐字原文片段"}]}',
].join("\n");

export interface BriefOverviewSentence {
  text: string;
  chunk_id: string;
  material_id: string;
  material_name: string;
  quote: string;
  citation: Citation;
}

export interface BriefMaterialStats {
  total: number;
  pending: number;
  processing: number;
  done: number;
  failed: number;
  needsConfig: number;
  byModality: Record<Modality, number>;
}

export interface BriefProcessingStats {
  elementCount: number;
  contradictionCount: number;
  unresolvedContradictionCount: number;
  findingCount: number;
  approvedFindingCount: number;
}

export interface BriefEntity {
  id: string;
  name: string;
  type: ElementType;
  freq: number;
}

export interface BriefContradiction {
  id: string;
  entity: string;
  attribute?: string;
  confidence: number;
  scope: "cross-material" | "intra-material";
  rationale: string;
  claim_a: { text: string; citation: Citation };
  claim_b: { text: string; citation: Citation };
  acknowledgement_status: ContradictionAcknowledgementStatus | null;
}

export type BriefOpenQuestion = QuestionSuggestion;

/** 落盘缓存的研判快照（进指纹的派生部分）。任务/autopilot/覆盖度等实时字段不在此。 */
interface BriefSnapshot {
  fingerprint: string;
  generatedAt: string;
  degraded: boolean;
  /** 本次概览降级原因；不含密钥/原文。 */
  lastError?: string;
  overview: BriefOverviewSentence[];
  materials: BriefMaterialStats;
  processing: BriefProcessingStats;
  timeline: TimelinePoint[];
  entities: BriefEntity[];
  contradictions: BriefContradiction[];
  openQuestions: BriefOpenQuestion[];
}

/** GET /cases/:id/brief 的完整响应：缓存快照 + 每次现算的实时字段。 */
export interface CaseBrief extends BriefSnapshot {
  caseId: string;
  /** 阶段条与运行状态（实时，不进指纹）。无运行则 null。 */
  task: TaskRunSnapshot | null;
  /** autopilot 是否开启（`autopilot !== false`，实时）。 */
  autopilot: boolean;
  /** 自动研判批处理进度（阶段三 M3，实时读 auto-inquiry.json，不进指纹）。未跑过则 null。 */
  autoInquiry: AutoInquiryProgress | null;
  /** 报告五节覆盖度（阶段三 M4，现算，不进指纹）。 */
  coverage: ReportCoverage;
}

interface RawOverviewSentence {
  text?: unknown;
  chunk_id?: unknown;
  quote?: unknown;
}

interface OverviewResult {
  sentences: BriefOverviewSentence[];
  degraded: boolean;
  reason?: string;
}

function hasConfigCue(note?: string): boolean {
  return Boolean(note && (note.includes("请先配置") || note.includes("未配置") || note.includes("授权") || note.includes("白名单") || note.includes("拦截")));
}

function mediaConfigured(modality: Modality, configs: SlotConfigs, mock: boolean): boolean {
  if (mock) return modality === "audio" || modality === "video" || modality === "image";
  if (modality === "audio") return configs.asr.configured;
  if (modality === "image") return configs.vlm.configured || configs.ocr.configured;
  if (modality === "video") return configs.asr.configured || configs.vlm.configured || configs.ocr.configured;
  return false;
}

function needsConfig(material: { modality: Modality; note?: string }, configs: SlotConfigs, mock: boolean): boolean {
  return hasConfigCue(material.note) && !mediaConfigured(material.modality, configs, mock);
}

export class BriefService {
  /** 同一专题+同一输入指纹只允许一次聚合/LLM 计算。 */
  private readonly inflight = new Map<string, Promise<BriefSnapshot>>();

  constructor(
    private readonly paths: DataPaths,
    private readonly audit: AuditService,
    private readonly cases: Pick<CaseService, "get">,
    private readonly materials: Pick<MaterialService, "loadCaseChunks">,
    private readonly elements: Pick<ElementService, "get">,
    private readonly elementGraph: Pick<ElementGraphService, "graph">,
    private readonly contradictions: Pick<ContradictionService, "getResult">,
    private readonly findings: Pick<FindingService, "list">,
    private readonly tasks: Pick<TaskService, "getCurrentRun">,
    private readonly suggestions: Pick<SuggestionService, "suggestQuestions">,
    private readonly autoInquiry: Pick<AutoInquiryService, "getProgress">,
    private readonly llm: LlmDeps,
  ) {}

  /** 取本专题研判简报：命中新鲜缓存则直接返回，否则重算并落盘。密级由 cases.get 收口。 */
  async getBrief(actor: Identity, caseId: string, options: { refresh?: boolean } = {}): Promise<CaseBrief> {
    // 访问闸门（密级 + 存在性）：不可读的专题在此抛 403/404，与其他读服务一致。
    const manifest = await this.cases.get(actor, caseId);
    const fingerprint = await this.computeFingerprint(caseId, manifest);

    const cached = await this.readSnapshot(caseId);
    const snapshot = !options.refresh && cached && cached.fingerprint === fingerprint
      ? cached
      : await this.recomputeSingleflight(actor, caseId, manifest, fingerprint, cached);

    // 实时字段每次现算叠加（不进缓存/指纹）：任务阶段条、autopilot 开关、自动研判进度、报告覆盖度。
    const [task, autoInquiry, coverage] = await Promise.all([
      this.tasks.getCurrentRun(actor, caseId),
      this.autoInquiry.getProgress(caseId),
      computeCoverage(this.paths, caseId, manifest),
    ]);
    return {
      ...snapshot,
      caseId,
      task,
      autopilot: manifest.autopilot !== false,
      autoInquiry,
      coverage,
    };
  }

  private recomputeSingleflight(
    actor: Identity,
    caseId: string,
    manifest: CaseManifest,
    fingerprint: string,
    cached: BriefSnapshot | null,
  ): Promise<BriefSnapshot> {
    const key = `${caseId}:${fingerprint}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const run = this.recompute(actor, caseId, manifest, fingerprint, cached).finally(() => {
      if (this.inflight.get(key) === run) this.inflight.delete(key);
    });
    this.inflight.set(key, run);
    return run;
  }

  private async recompute(actor: Identity, caseId: string, manifest: CaseManifest, fingerprint: string, cached: BriefSnapshot | null): Promise<BriefSnapshot> {
    const [elements, graph, contradictionResult, findingList, openQuestions, overview] = await Promise.all([
      this.elements.get(actor, caseId),
      this.elementGraph.graph(actor, caseId),
      this.contradictions.getResult(actor, caseId),
      this.findings.list(actor, caseId),
      this.suggestions.suggestQuestions(actor, caseId),
      this.generateOverview(actor, caseId, new Map(manifest.materials.map((m) => [m.id, m.filename]))),
    ]);

    const ackByContradiction = new Map(
      (contradictionResult.acknowledgements ?? []).map((ack) => [ack.contradiction_id, ack.status]),
    );
    const unresolved = contradictionResult.contradictions
      .filter((contradiction) => (ackByContradiction.get(contradiction.id) ?? "open") === "open")
      .slice()
      .sort((a, b) => b.confidence - a.confidence);

    const snapshot: BriefSnapshot = {
      fingerprint,
      generatedAt: new Date().toISOString(),
      degraded: overview.degraded,
      ...(overview.reason ? { lastError: overview.reason } : {}),
      overview: overview.sentences,
      materials: this.materialStats(manifest),
      processing: {
        elementCount: elements.length,
        contradictionCount: contradictionResult.contradictions.length,
        unresolvedContradictionCount: unresolved.length,
        findingCount: findingList.length,
        approvedFindingCount: findingList.filter((finding) => finding.review_status === "approved").length,
      },
      timeline: graph.timeline.slice(0, TIMELINE_TOP),
      entities: elements
        .slice()
        .sort((a, b) => b.freq - a.freq || a.name.localeCompare(b.name))
        .slice(0, ENTITIES_TOP)
        .map((element) => ({ id: element.id, name: element.name, type: element.type, freq: element.freq })),
      contradictions: unresolved.slice(0, CONTRADICTIONS_TOP).map((contradiction) => ({
        id: contradiction.id,
        entity: contradiction.entity,
        attribute: contradiction.attribute,
        confidence: contradiction.confidence,
        scope: contradiction.scope,
        rationale: contradiction.rationale,
        claim_a: contradiction.claim_a,
        claim_b: contradiction.claim_b,
        acknowledgement_status: ackByContradiction.get(contradiction.id) ?? null,
      })),
      openQuestions: openQuestions.slice(0, OPEN_QUESTIONS_TOP),
    };

    const hasLastGood = Boolean(cached && !cached.degraded && cached.overview.length > 0);
    const stableDegraded = overview.reason === "llm-unconfigured"
      || overview.reason === "no-chunks"
      || overview.reason === "overview-sentences-rejected";
    // 暂时中止/网络错误不覆盖 last-good；首次就遇到暂态错误也不落盘，下次 GET 可自动重试。
    const preserveCache = overview.degraded && (hasLastGood || !stableDegraded);
    if (!preserveCache) await this.writeSnapshot(caseId, snapshot);
    await this.audit.append({
      user: actor.id,
      action: "brief.generate",
      object: `case:${caseId}`,
      caseId,
      detail: {
        caseId,
        degraded: snapshot.degraded,
        sentences: snapshot.overview.length,
        elements: snapshot.processing.elementCount,
        unresolvedContradictions: snapshot.processing.unresolvedContradictionCount,
        cachePreserved: preserveCache,
        ...(overview.reason ? { overviewReason: overview.reason } : {}),
      },
    });
    return snapshot;
  }

  /**
   * 生成案情概览段：喂编号素材片段，要求逐句携带 chunk_id + 逐字 quote，服务端逐句校验后
   * 丢弃不过关句。LLM 未配置 / 无已加工素材 / 出站被拒 / 生成失败 → 降级为空（纯统计简报）。
   */
  private async generateOverview(actor: Identity, caseId: string, materialNames: Map<string, string>): Promise<OverviewResult> {
    const chunks = await this.materials.loadCaseChunks(caseId);
    if (!this.llm.adapter || !this.llm.modelEndpoint) return { sentences: [], degraded: true, reason: "llm-unconfigured" };
    if (chunks.length === 0) return { sentences: [], degraded: true, reason: "no-chunks" };

    try {
      // 零外发红线：出站前先经 OfflineGuard 授权（授权失败 → 降级，不阻断整份简报）。
      await this.llm.guard.authorize(this.llm.modelEndpoint, { user: actor.id, purpose: "brief-overview" });
      const context = this.buildContext(chunks);
      const raw = await generateJson(this.llm.adapter, OVERVIEW_SYSTEM_PROMPT, `素材片段：\n${context}\n\n请只输出 JSON。`, {
        maxTokens: 1500,
      });
      const retrievedById = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
      const nameById = new Map(chunks.map((chunk) => [chunk.material_id, materialNames.get(chunk.material_id) ?? chunk.material_id]));
      const sentences = this.validateSentences(raw.sentences, retrievedById, nameById);
      // 一句都没通过校验也按降级处理并留痕，否则界面只见空概览、无从定位原因。
      if (sentences.length === 0) return { sentences, degraded: true, reason: "overview-sentences-rejected" };
      return { sentences, degraded: false };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { sentences: [], degraded: true, reason: message || "unknown-error" };
    }
  }

  /** 逐句校验：chunk 存在、内容哈希一致、quote 可逐字定位（与 cite 工具同一模糊回退）；不过关整句丢弃（防编造）。 */
  private validateSentences(raw: unknown, retrievedById: Map<string, Chunk>, nameById: Map<string, string>): BriefOverviewSentence[] {
    const list = Array.isArray(raw) ? (raw as RawOverviewSentence[]) : [];
    const sentences: BriefOverviewSentence[] = [];
    for (const item of list) {
      const text = typeof item?.text === "string" ? item.text.trim() : "";
      const chunkId = typeof item?.chunk_id === "string" ? item.chunk_id : "";
      const rawQuote = typeof item?.quote === "string" ? item.quote.trim() : "";
      if (!text || !chunkId || !rawQuote) continue;
      const chunk = retrievedById.get(chunkId);
      if (!chunk) continue; // chunk_id 不在本次上下文 → 丢弃（凭空捏造）
      if (sha256(chunk.text) !== chunk.content_hash) continue; // 素材变更后失效
      // 严格子串失败后走与 cite 相同的归一化模糊定位，命中则登记原文逐字片段（哈希保证不变）。
      const quote = chunk.text.includes(rawQuote) ? rawQuote : fuzzyLocate(chunk.text, rawQuote)?.quote;
      if (!quote) continue; // 归一化仍无法定位 → 丢弃
      let citation: Citation;
      try {
        citation = chunkToCitation(chunk, nameById.get(chunk.material_id) ?? chunk.material_id, 0.6, quote);
      } catch {
        continue; // chunkToCitation 会再核一次子串，失败即丢弃
      }
      sentences.push({
        text,
        chunk_id: chunkId,
        material_id: chunk.material_id,
        material_name: citation.material_name,
        quote,
        citation,
      });
      if (sentences.length >= MAX_OVERVIEW_SENTENCES) break;
    }
    return sentences;
  }

  /** 按字符预算拼接编号片段作为概览上下文（大专题只取前若干片段，控 token）。 */
  private buildContext(chunks: Chunk[]): string {
    const parts: string[] = [];
    let used = 0;
    for (const chunk of chunks) {
      const piece = `[${chunk.chunk_id}] ${chunk.text}`;
      if (used + piece.length > MAX_OVERVIEW_CONTEXT_CHARS && parts.length > 0) break;
      parts.push(piece);
      used += piece.length;
    }
    return parts.join("\n\n");
  }

  private materialStats(manifest: CaseManifest): BriefMaterialStats {
    const slotConfigs = readSlotConfigs();
    const mockMedia = useMockMedia();
    const byModality: Record<Modality, number> = { doc: 0, audio: 0, video: 0, image: 0 };
    for (const material of manifest.materials) byModality[material.modality]++;
    return {
      total: manifest.materials.length,
      pending: manifest.materials.filter((m) => m.status === "pending").length,
      processing: manifest.materials.filter((m) => m.status === "processing").length,
      done: manifest.materials.filter((m) => m.status === "done").length,
      failed: manifest.materials.filter((m) => m.status === "failed").length,
      needsConfig: manifest.materials.filter((m) => m.status === "pending" && needsConfig(m, slotConfigs, mockMedia)).length,
      byModality,
    };
  }

  /**
   * 轻量指纹（D5）：素材签名（id/状态/切块数/加工时间）+ 各产物文件 size:mtime。
   * 素材、要素、矛盾（含 ack 处置）、结论任一变更即失配 → 触发重算；确认检查点等
   * 只写 task-runs.json 的操作不进指纹，故不会误触发 LLM 重跑。
   */
  private async computeFingerprint(caseId: string, manifest: CaseManifest): Promise<string> {
    const materialSig = manifest.materials
      .map((m) => `${m.id}:${m.status}:${m.chunk_count ?? 0}:${m.processed_at ?? ""}`)
      .sort()
      .join("|");
    const dir = this.paths.caseDir(caseId);
    const files = await Promise.all([
      this.fileSig(path.join(dir, "elements.json")),
      this.fileSig(path.join(dir, "contradictions.result.json")),
      this.fileSig(path.join(dir, "contradiction-acks.json")),
      this.fileSig(findingsFilePath(this.paths, caseId)),
    ]);
    return sha256(JSON.stringify({ count: manifest.materials.length, materialSig, files }));
  }

  private async fileSig(file: string): Promise<string> {
    try {
      const info = await stat(file);
      return `${info.size}:${Math.round(info.mtimeMs)}`;
    } catch {
      return "absent";
    }
  }

  private async readSnapshot(caseId: string): Promise<BriefSnapshot | null> {
    try {
      const parsed = JSON.parse(await readFile(this.briefFile(caseId), "utf8")) as BriefSnapshot;
      return parsed && typeof parsed.fingerprint === "string" ? parsed : null;
    } catch {
      // 缺失或损坏的缓存一律当未命中，交由重算覆盖。
      return null;
    }
  }

  private async writeSnapshot(caseId: string, snapshot: BriefSnapshot): Promise<void> {
    await writeFileAtomic(this.briefFile(caseId), `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  private briefFile(caseId: string): string {
    return path.join(this.paths.caseDir(caseId), "brief.json");
  }
}
