import type { CaseService } from "../cases/case-service.js";
import type { ContradictionService } from "../analysis/contradiction-service.js";
import type {
  CaseManifest,
  ElementType,
  FindingReviewStatus,
  Identity,
  Inquiry,
  MaterialStatus,
  Modality,
} from "../domain/types.js";
import type { ElementService } from "../elements/element-service.js";
import type { FindingService } from "../finding/finding-service.js";
import type { InquiryService } from "../inquiry/inquiry-service.js";
import type { MaterialService } from "../materials/material-service.js";

/**
 * 上下文聚合层（智能工作流自动化决策文档 §阶段 2.1）。按用途裁剪专题数据，
 * 供 LLM 增强功能（问题生成 / 报告草稿 / 声明核实）消费，避免每个 Agent 任务
 * 各自重复收集、且把全量数据无差别塞进提示词（费 token、稀释关键信息）。
 */

export type ContextPurpose = "suggest-questions" | "generate-report" | "verify-claims";

export interface MaterialSummary {
  id: string;
  filename: string;
  modality: Modality;
  status: MaterialStatus;
  chunkCount: number;
  /** 首若干切块拼接后的摘录，按用途截断（详见 EXCERPT_CHARS）。未加工完成则为空串。 */
  excerpt: string;
}

export interface ElementSummary {
  id: string;
  type: ElementType;
  name: string;
  freq: number;
}

export interface ContradictionSummary {
  id: string;
  entity: string;
  attribute?: string;
  confidence: number;
  rationale: string;
}

export interface InquirySummary {
  id: string;
  question: string;
  status: Inquiry["status"];
  claimCount: number;
}

export interface FindingSummary {
  id: string;
  conclusion: string;
  confidence: number;
  review_status: FindingReviewStatus;
}

export interface AgentContext {
  case: CaseManifest;
  materials: MaterialSummary[];
  elements: ElementSummary[];
  contradictions: ContradictionSummary[];
  inquiries: InquirySummary[];
  findings: FindingSummary[];
  estimatedTokens: number;
}

/** 粗略折算：中英混排场景下 1 token ≈ 4 字符（要求见任务说明，非精确分词）。 */
const CHARS_PER_TOKEN = 4;
/** 未显式指定 maxTokens 时的默认预算：足够覆盖典型专题的裁剪后上下文，同时不至于无节制。 */
const DEFAULT_MAX_TOKENS = 4000;
/** 上下文缓存有效期：专题数据在此窗口内变化的概率低，重复请求（如连续两次问题推荐）可复用。 */
const CACHE_TTL_MS = 30_000;

const MATERIAL_LIMITS: Record<ContextPurpose, number> = {
  "suggest-questions": 12,
  "generate-report": 20,
  "verify-claims": 30,
};
const EXCERPT_CHARS: Record<ContextPurpose, number> = {
  // 问题生成需要看到完整事实邻域；200 字会把同一条车辆/时间记录截成错误前提。
  "suggest-questions": 600,
  "generate-report": 150,
  "verify-claims": 800,
};
const ELEMENT_LIMITS: Record<ContextPurpose, number> = {
  "suggest-questions": 20,
  "generate-report": 30,
  "verify-claims": 15,
};
const CONTRADICTION_LIMITS: Record<ContextPurpose, number> = {
  "suggest-questions": 8,
  "generate-report": 10,
  "verify-claims": 5,
};
const INQUIRY_LIMITS: Record<ContextPurpose, number> = {
  "suggest-questions": 10,
  "generate-report": 5,
  "verify-claims": 5,
};
const FINDING_LIMITS: Record<ContextPurpose, number> = {
  // 问题推荐要找"还没有结论"的方向，已有结论只需极少量作参考（避免重复推荐）。
  "suggest-questions": 3,
  "generate-report": 30,
  "verify-claims": 10,
};

/** 粗略 token 估算：非字符串先序列化为 JSON 再折算（用于整份 AgentContext 或其子集）。 */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil((text?.length ?? 0) / CHARS_PER_TOKEN);
}

/** 数组长度高于 minLength 时丢弃末位一条（各数组已按重要性降序排列）。 */
function popIfMoreThan<T>(list: T[], minLength: number): boolean {
  if (list.length <= minLength) return false;
  list.pop();
  return true;
}

export class ContextService {
  /** caseId+purpose → 已构建上下文（未按 maxTokens 裁剪的完整版）。见 CACHE_TTL_MS。 */
  private readonly cache = new Map<string, { context: AgentContext; builtAt: number }>();

  constructor(
    private readonly cases: CaseService,
    private readonly materials: MaterialService,
    private readonly elements: ElementService,
    private readonly contradictions: ContradictionService,
    private readonly inquiries: InquiryService,
    private readonly findings: FindingService,
  ) {}

  /**
   * 构建按用途裁剪的专题上下文。注意：签名比决策文档草案多一个 `actor` 首参——
   * 本服务内部要读取专题及其派生数据，若不做权限闸门会绕过密级校验（此仓库所有
   * 读服务一贯以 actor 作首参，§7.5）；`cases.get` 在此处即是权限校验点，故不缓存，
   * 每次都实际执行，缓存只覆盖其后的（较重的）数据聚合。
   */
  async buildContext(actor: Identity, caseId: string, purpose: ContextPurpose, options: { maxTokens?: number } = {}): Promise<AgentContext> {
    const manifest = await this.cases.get(actor, caseId);

    const cacheKey = `${caseId}:${purpose}`;
    const cached = this.cache.get(cacheKey);
    let context: AgentContext;
    if (cached && Date.now() - cached.builtAt < CACHE_TTL_MS) {
      context = cached.context;
    } else {
      const [materialSummaries, elementSummaries, contradictionResult, inquiryList, findingList] = await Promise.all([
        this.selectRelevantMaterials(caseId, purpose, manifest),
        this.selectKeyElements(actor, caseId, purpose),
        this.contradictions.getResult(actor, caseId),
        this.inquiries.list(actor, caseId),
        this.findings.list(actor, caseId),
      ]);

      const contradictionSummaries: ContradictionSummary[] = contradictionResult.contradictions
        .slice()
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, CONTRADICTION_LIMITS[purpose])
        .map((c) => ({ id: c.id, entity: c.entity, attribute: c.attribute, confidence: c.confidence, rationale: c.rationale }));

      const inquirySummaries: InquirySummary[] = inquiryList
        .slice()
        .sort((a, b) => b.ts.localeCompare(a.ts))
        .slice(0, INQUIRY_LIMITS[purpose])
        .map((i) => ({ id: i.id, question: i.question, status: i.status, claimCount: i.claims.length }));

      const findingSummaries: FindingSummary[] = findingList
        .slice()
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, FINDING_LIMITS[purpose])
        .map((f) => ({ id: f.id, conclusion: f.conclusion, confidence: f.confidence, review_status: f.review_status }));

      context = {
        case: manifest,
        materials: materialSummaries,
        elements: elementSummaries,
        contradictions: contradictionSummaries,
        inquiries: inquirySummaries,
        findings: findingSummaries,
        estimatedTokens: 0,
      };
      context.estimatedTokens = estimateTokens(context);
      this.cache.set(cacheKey, { context, builtAt: Date.now() });
    }

    return this.trimToTokenBudget(context, options.maxTokens);
  }

  /** 素材摘要：优先已加工完成、切块数多（信息量大）的素材，按用途上限截断，摘录长度也按用途区分。 */
  private async selectRelevantMaterials(caseId: string, purpose: ContextPurpose, manifest: CaseManifest): Promise<MaterialSummary[]> {
    const chunks = await this.materials.loadCaseChunks(caseId);
    const chunksByMaterial = new Map<string, string[]>();
    for (const chunk of chunks) {
      const texts = chunksByMaterial.get(chunk.material_id);
      if (texts) texts.push(chunk.text);
      else chunksByMaterial.set(chunk.material_id, [chunk.text]);
    }

    const excerptChars = EXCERPT_CHARS[purpose];
    const summaries: MaterialSummary[] = manifest.materials.map((material) => {
      const texts = chunksByMaterial.get(material.id) ?? [];
      return {
        id: material.id,
        filename: material.filename,
        modality: material.modality,
        status: material.status,
        chunkCount: material.chunk_count ?? texts.length,
        excerpt: texts.join(" ").slice(0, excerptChars),
      };
    });

    summaries.sort((a, b) => {
      const doneA = a.status === "done" ? 1 : 0;
      const doneB = b.status === "done" ? 1 : 0;
      if (doneA !== doneB) return doneB - doneA;
      return b.chunkCount - a.chunkCount;
    });

    return summaries.slice(0, MATERIAL_LIMITS[purpose]);
  }

  /** 要素摘要：按提及频次降序，按用途上限截断（高频要素通常是问答/报告的核心线索）。 */
  private async selectKeyElements(actor: Identity, caseId: string, purpose: ContextPurpose): Promise<ElementSummary[]> {
    const elements = await this.elements.get(actor, caseId);
    return elements
      .map((e) => ({ id: e.id, type: e.type, name: e.name, freq: e.freq }))
      .sort((a, b) => b.freq - a.freq)
      .slice(0, ELEMENT_LIMITS[purpose]);
  }

  /**
   * Token 预算裁剪：各子数组已按重要性（置信度/新鲜度/频次）降序排列，超预算时按
   * findings → inquiries → contradictions → elements → materials 的顺序从尾部
   * （最不重要的一条）逐一丢弃，直至落入预算或再无可丢（materials 至少保留 1 条——
   * 无素材线索时下游 Agent 无从下手）。不改变入参对象（缓存的是裁剪前的完整版）。
   */
  private trimToTokenBudget(context: AgentContext, maxTokens?: number): AgentContext {
    const budget = maxTokens ?? DEFAULT_MAX_TOKENS;
    const trimmed: AgentContext = {
      case: context.case,
      materials: [...context.materials],
      elements: [...context.elements],
      contradictions: [...context.contradictions],
      inquiries: [...context.inquiries],
      findings: [...context.findings],
      estimatedTokens: context.estimatedTokens,
    };

    if (estimateTokens(trimmed) <= budget) return trimmed;

    const steps: (() => boolean)[] = [
      () => popIfMoreThan(trimmed.findings, 0),
      () => popIfMoreThan(trimmed.inquiries, 0),
      () => popIfMoreThan(trimmed.contradictions, 0),
      () => popIfMoreThan(trimmed.elements, 0),
      () => popIfMoreThan(trimmed.materials, 1),
    ];

    let progressed = true;
    while (estimateTokens(trimmed) > budget && progressed) {
      progressed = false;
      for (const step of steps) {
        if (estimateTokens(trimmed) <= budget) break;
        if (step()) progressed = true;
      }
    }

    trimmed.estimatedTokens = estimateTokens(trimmed);
    return trimmed;
  }
}
