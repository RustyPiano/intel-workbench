import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildElementGraph } from "../analysis/element-graph.js";
import type { DataPaths } from "../data/paths.js";
import type { CaseManifest, Contradiction, ContradictionAcknowledgement, Element, Finding } from "../domain/types.js";
import { readContradictionAcknowledgements, readFindings } from "../finding/finding-store.js";

/**
 * 报告覆盖率仪表（阶段三 M4 / 计划 D4）。报告模板固定五节——背景与素材概况 / 关键时间线 /
 * 矛盾核验 / 研判结论 / 未决事项。每节映射一条「以现有落盘产物即可判定」的证据要求；覆盖度 =
 * 满足要求的节数 / 总节数，节内给出人话缺口明细与前端引导（目标 Tab + 动词短语）。
 *
 * 只做展示与引导，不新增导出硬门禁（既有引用完整性门禁在 report-service.evaluateExportGate，
 * 本模块与其互不影响）。纯只读函数：直接读专题目录下的既有产物，不写盘、不调 LLM、不记审计，
 * 故属「每请求现算」侧（简报与报告页各自现算叠加，不进 brief 指纹缓存）。
 */

/** 矛盾「高置信」阈值：与 report-service.hasHighSeverityContradiction（导出闸）同口径 0.75。 */
const HIGH_CONFIDENCE = 0.75;
/** 时间线成节所需的锚定时间点数（TimelinePoint.sortKey 非空即已锚定到绝对时间轴）。 */
const TIMELINE_ANCHOR_MIN = 3;

export type CoverageSectionKey = "background" | "timeline" | "contradiction" | "conclusion" | "open-items";

export interface CoverageSection {
  key: CoverageSectionKey;
  title: string;
  satisfied: boolean;
  /** 满足/缺口明细（人话，如「2/4 条高置信矛盾未处置」）。 */
  detail: string;
  /** 前端引导：目标 Tab + 简短动词短语（缺口时用于深链跳转补证据）。 */
  action: { tab: string; label: string };
}

export interface ReportCoverage {
  satisfiedCount: number;
  totalSections: number;
  sections: CoverageSection[];
}

/** 自动研判进度只取判定「未决事项」所需的最小字段（durable，读 auto-inquiry.json）。 */
interface AutoInquiryLite {
  status?: "running" | "done" | "cancelled";
  total?: number;
  completed?: number;
  items?: { status?: string }[];
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** 矛盾来源与导出闸一致：优先 contradictions.result.json，回退 legacy contradictions.json。 */
async function loadContradictions(paths: DataPaths, caseId: string): Promise<Contradiction[]> {
  const dir = paths.caseDir(caseId);
  const result = await readJson<{ contradictions?: Contradiction[] }>(path.join(dir, "contradictions.result.json"));
  if (result && Array.isArray(result.contradictions)) return result.contradictions;
  const legacy = await readJson<Contradiction[]>(path.join(dir, "contradictions.json"));
  return Array.isArray(legacy) ? legacy : [];
}

/** 计算本专题的报告五节覆盖度。manifest 由调用方经密级闸门（cases.get）取得后传入。 */
export async function computeCoverage(paths: DataPaths, caseId: string, manifest: CaseManifest): Promise<ReportCoverage> {
  const dir = paths.caseDir(caseId);
  const [elements, contradictions, acks, findings, autoInquiry] = await Promise.all([
    readJson<Element[]>(path.join(dir, "elements.json")),
    loadContradictions(paths, caseId),
    readContradictionAcknowledgements(paths, caseId),
    readFindings(paths, caseId),
    readJson<AutoInquiryLite>(path.join(dir, "auto-inquiry.json")),
  ]);

  const sections: CoverageSection[] = [
    backgroundSection(manifest),
    timelineSection(Array.isArray(elements) ? elements : []),
    contradictionSection(contradictions, acks),
    conclusionSection(findings),
    openItemsSection(autoInquiry),
  ];
  return {
    satisfiedCount: sections.filter((section) => section.satisfied).length,
    totalSections: sections.length,
    sections,
  };
}

/** 背景与素材概况：至少 1 份素材加工完成。 */
function backgroundSection(manifest: CaseManifest): CoverageSection {
  const total = manifest.materials.length;
  const done = manifest.materials.filter((material) => material.status === "done").length;
  const satisfied = done >= 1;
  return {
    key: "background",
    title: "背景与素材概况",
    satisfied,
    detail: satisfied
      ? `已加工完成 ${done}/${total} 份素材`
      : total === 0
        ? "尚未上传任何素材"
        : `暂无加工完成的素材（${done}/${total}）`,
    action: { tab: "materials", label: "上传并加工素材" },
  };
}

/** 关键时间线：锚定到绝对时间轴的时间点 ≥3（复用要素图谱的时间线派生逻辑）。 */
function timelineSection(elements: Element[]): CoverageSection {
  const anchored = buildElementGraph(elements).timeline.filter((point) => point.sortKey !== null).length;
  const satisfied = anchored >= TIMELINE_ANCHOR_MIN;
  return {
    key: "timeline",
    title: "关键时间线",
    satisfied,
    detail: satisfied
      ? `已锚定 ${anchored} 个时间点`
      : `已锚定 ${anchored}/${TIMELINE_ANCHOR_MIN} 个时间点，尚不足以支撑时间线`,
    action: { tab: "elements", label: "补充时间要素" },
  };
}

/** 矛盾核验：无未处置的高置信矛盾（confidence ≥ 0.75 且处置状态为 open）。 */
function contradictionSection(contradictions: Contradiction[], acks: ContradictionAcknowledgement[]): CoverageSection {
  const statusById = new Map(acks.map((ack) => [ack.contradiction_id, ack.status]));
  const highConf = contradictions.filter((contradiction) => (contradiction.confidence ?? 0) >= HIGH_CONFIDENCE);
  const unresolved = highConf.filter((contradiction) => (statusById.get(contradiction.id) ?? "open") === "open");
  const satisfied = unresolved.length === 0;
  return {
    key: "contradiction",
    title: "矛盾核验",
    satisfied,
    detail: satisfied
      ? highConf.length === 0
        ? "未检出高置信矛盾"
        : `${highConf.length} 条高置信矛盾均已处置`
      : `${unresolved.length}/${highConf.length} 条高置信矛盾未处置`,
    action: { tab: "contradictions", label: "处置高置信矛盾" },
  };
}

/** 研判结论：至少 1 条已核准 Finding。 */
function conclusionSection(findings: Finding[]): CoverageSection {
  const approved = findings.filter((finding) => finding.review_status === "approved").length;
  const candidates = findings.filter((finding) => finding.review_status === "draft").length;
  const satisfied = approved >= 1;
  return {
    key: "conclusion",
    title: "研判结论",
    satisfied,
    detail: satisfied
      ? `已核准 ${approved} 条结论`
      : candidates > 0
        ? `尚无已核准结论（${candidates} 条候选待复核）`
        : "尚无已核准结论，也无候选可复核",
    action: { tab: "findings", label: "核准候选结论" },
  };
}

/**
 * 未决事项：无「悬空」待核问题。口径以 M3 自动研判批次为准——批次已跑完（非 running）且每题都已
 * 闭环（产生候选 candidate 或已问完 done）；仍处于 pending/running/failed 的题目视为悬空。批次从未
 * 运行（progress 缺失）则视为未闭环，引导用户运行自动研判把待核问题跑完。
 */
function openItemsSection(progress: AutoInquiryLite | null): CoverageSection {
  const action = { tab: "inquiry", label: "补充核验待核问题" };
  if (!progress) {
    return { key: "open-items", title: "未决事项", satisfied: false, detail: "自动研判尚未运行，待核问题未闭环", action: { tab: "inquiry", label: "运行自动研判" } };
  }
  const items = Array.isArray(progress.items) ? progress.items : [];
  const total = items.length;
  if (progress.status === "running") {
    return { key: "open-items", title: "未决事项", satisfied: false, detail: `自动研判进行中（${progress.completed ?? 0}/${total}）`, action };
  }
  const dangling = items.filter((item) => item.status === "pending" || item.status === "running" || item.status === "failed").length;
  const satisfied = dangling === 0;
  return {
    key: "open-items",
    title: "未决事项",
    satisfied,
    detail: satisfied
      ? total === 0
        ? "自动研判已完成，无待核问题悬空"
        : `${total} 个待核问题均已闭环`
      : `${dangling}/${total} 个待核问题仍悬空（未产生候选或失败）`,
    action,
  };
}
