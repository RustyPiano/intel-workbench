import { buildElementGraph } from "../analysis/element-graph.js";
import type { ContradictionService } from "../analysis/contradiction-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { DataPaths } from "../data/paths.js";
import type { Citation, ElementType, Finding, Identity, TimelinePoint } from "../domain/types.js";
import type { ElementService } from "../elements/element-service.js";
import type { FindingService } from "../finding/finding-service.js";
import { computeCoverage, type ReportCoverage } from "../report/coverage.js";

/**
 * 研判简报 —— 破坏性收敛 R2 后的**确定性投影**（批次 D）。
 *
 * 只读既有落盘产物，把一份案卷投影成一屏可核验视图：概览句、已验证时间线、关键要素、
 * 未处置高置信矛盾、已核准 Finding、报告覆盖率。GET 不写任何文件、不落审计、不调模型，
 * 故同一份产物必然得到一致结果（旧版的 brief.json 缓存 / 指纹 / last-good / LLM 概览 /
 * OfflineGuard 出站 / ?refresh / degraded 全部删除）。实时执行状态（task/自动研判/素材统计）
 * 改由 GET /cases/:id/status 提供，不再进本视图。
 */

/** 未处置矛盾「高置信」阈值 0.75。ponytail: 与 report/coverage.ts 及导出闸同口径的字面量，不跨文件耦合。 */
const HIGH_CONFIDENCE = 0.75;
const TIMELINE_TOP = 8;
const ENTITIES_TOP = 8;
const CONTRADICTIONS_TOP = 8;
const MAX_OVERVIEW_SENTENCES = 6;
const OVERVIEW_FROM_FINDINGS = 3;
const OVERVIEW_FROM_CONTRADICTIONS = 2;
const OVERVIEW_FROM_TIMELINE = 2;

/** 概览句：一句结论 + 其在产物中已有的引用（形状 {text, citation}）。 */
export interface BriefOverviewSentence {
  text: string;
  citation: Citation;
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
}

/** GET /cases/:id/brief 的完整响应（确定性投影，无缓存/时间戳字段）。 */
export interface CaseBrief {
  caseId: string;
  /** 概览句：从已核准 Finding、未处置高置信矛盾、时间线锚点各取代表句派生。 */
  overview: BriefOverviewSentence[];
  /** 已验证时间线（要素图谱派生，含未锚定点）。 */
  timeline: TimelinePoint[];
  /** 关键要素（按频次降序）。 */
  entities: BriefEntity[];
  /** 未处置高置信矛盾（confidence ≥ 0.75 且处置状态为 open）。 */
  contradictions: BriefContradiction[];
  /** 已核准 Finding。 */
  approvedFindings: Finding[];
  /** 报告五节覆盖度（复用 coverage）。 */
  coverage: ReportCoverage;
}

export class BriefService {
  constructor(
    private readonly paths: DataPaths,
    private readonly cases: Pick<CaseService, "get">,
    private readonly elements: Pick<ElementService, "get">,
    private readonly contradictions: Pick<ContradictionService, "getResult">,
    private readonly findings: Pick<FindingService, "list">,
  ) {}

  /** 取本专题研判简报的确定性投影。密级由 cases.get 收口（不可读专题在此抛 403/404）。 */
  async getBrief(actor: Identity, caseId: string): Promise<CaseBrief> {
    const manifest = await this.cases.get(actor, caseId);
    const [elements, contradictionResult, findingList, coverage] = await Promise.all([
      this.elements.get(actor, caseId),
      this.contradictions.getResult(actor, caseId),
      this.findings.list(actor, caseId),
      computeCoverage(this.paths, caseId, manifest),
    ]);

    const graph = buildElementGraph(elements);
    const timeline = graph.timeline.slice(0, TIMELINE_TOP);

    const entities = elements
      .slice()
      .sort((a, b) => b.freq - a.freq || a.name.localeCompare(b.name))
      .slice(0, ENTITIES_TOP)
      .map((element): BriefEntity => ({ id: element.id, name: element.name, type: element.type, freq: element.freq }));

    const ackByContradiction = new Map(
      (contradictionResult.acknowledgements ?? []).map((ack) => [ack.contradiction_id, ack.status]),
    );
    const unresolved = contradictionResult.contradictions
      .filter((c) => (c.confidence ?? 0) >= HIGH_CONFIDENCE && (ackByContradiction.get(c.id) ?? "open") === "open")
      .slice()
      .sort((a, b) => b.confidence - a.confidence)
      .map((c): BriefContradiction => ({
        id: c.id,
        entity: c.entity,
        attribute: c.attribute,
        confidence: c.confidence,
        scope: c.scope,
        rationale: c.rationale,
        claim_a: c.claim_a,
        claim_b: c.claim_b,
      }));

    const approvedFindings = findingList.filter((f) => f.review_status === "approved");

    return {
      caseId,
      overview: buildOverview(approvedFindings, unresolved, timeline),
      timeline,
      entities,
      contradictions: unresolved.slice(0, CONTRADICTIONS_TOP),
      approvedFindings,
      coverage,
    };
  }
}

/**
 * 概览句确定性生成：从已核准 Finding、未处置高置信矛盾、时间线锚点各取代表句，
 * 每句沿用产物中已有的引用（无引用的来源跳过），总数封顶 6 句。
 */
function buildOverview(
  approvedFindings: Finding[],
  unresolved: BriefContradiction[],
  timeline: TimelinePoint[],
): BriefOverviewSentence[] {
  const sentences: BriefOverviewSentence[] = [];

  for (const finding of approvedFindings.slice(0, OVERVIEW_FROM_FINDINGS)) {
    const citation = finding.supporting_citations[0];
    if (citation) sentences.push({ text: finding.conclusion, citation });
  }

  for (const contradiction of unresolved.slice(0, OVERVIEW_FROM_CONTRADICTIONS)) {
    const text = contradiction.rationale.trim() || `${contradiction.claim_a.text} 与 ${contradiction.claim_b.text} 相互矛盾`;
    sentences.push({ text, citation: contradiction.claim_a.citation });
  }

  for (const point of timeline.filter((p) => p.sortKey !== null).slice(0, OVERVIEW_FROM_TIMELINE)) {
    const citation = point.citations[0];
    if (!citation) continue;
    const related = point.related.map((r) => r.name).join("、");
    sentences.push({ text: related ? `${point.label}——${related}` : point.label, citation });
  }

  return sentences.slice(0, MAX_OVERVIEW_SENTENCES);
}
