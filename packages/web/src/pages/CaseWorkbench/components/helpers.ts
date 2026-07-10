import {
  fetchMaterialRawUrl,
  type ApiCitation,
  type ApiClaim,
  type ApiMaterial,
  type MaterialContent,
  type ApiElement,
  type ApiReport,
  type CaseStatusPayload,
  type StatusSection,
} from "../../../api";
import type { LoadState } from "../../../types";

export function scrollWorkbenchBodyIntoView() {
  window.setTimeout(() => {
    document.querySelector<HTMLElement>(".workbench__body")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 0);
}

export const CITATION_VERDICT_LABELS: Record<ApiCitation["verdict"], string> = {
  supports: "支撑",
  contradicts: "相矛盾",
  mentions: "仅提及",
  context: "背景信息",
  pending: "待裁判",
};

export function verdictLabel(verdict?: ApiCitation["verdict"]): string {
  if (!verdict) return "";
  return CITATION_VERDICT_LABELS[verdict] ?? verdict;
}

export const CLAIM_SUPPORT_LABELS: Record<ApiClaim["support"], string> = {
  supported: "已支撑",
  pending: "待支撑裁判",
  unsupported: "不支撑",
};

/** 解析时间码 "start-end"（秒）→ [start, end]（二期 P2.3a）。 */
export function parseTimecode(tc?: string): [number, number] | null {
  if (!tc) return null;
  const [a, b] = tc.split("-");
  const s = Number(a);
  if (!Number.isFinite(s)) return null;
  const e = Number(b);
  return [s, Number.isFinite(e) ? e : s];
}

export function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function elapsedLabel(startedAt: number | undefined, now: number): string {
  if (!startedAt) return "进行中";
  const sec = Math.max(0, Math.round((now - startedAt) / 1000));
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return min > 0 ? `${min}m ${String(rest).padStart(2, "0")}s` : `${sec}s`;
}

export const MODALITY_LABELS: Record<ApiMaterial["modality"], string> = {
  doc: "文档",
  audio: "音频",
  video: "视频",
  image: "图片",
};

export const STATUS_LABELS: Record<ApiMaterial["status"], { text: string; color: string }> = {
  pending: { text: "待加工", color: "var(--warn-light)" },
  processing: { text: "加工中", color: "var(--warn-light)" },
  done: { text: "已完成", color: "var(--ok-light)" },
  failed: { text: "失败", color: "var(--danger-light)" },
};

export function isMediaModality(m: ApiMaterial["modality"]): boolean {
  return m === "audio" || m === "video" || m === "image";
}

export function mediaPendingText(m: ApiMaterial["modality"]): string {
  if (m === "audio") return "音频已上传，点击「开始加工」进行转写，生成带时间码的可引用片段。";
  if (m === "video") return "视频已上传，点击「开始加工」进行分镜、转写与画面识别；大文件可能需要较长时间。";
  return "图片已上传，点击「开始加工」进行配文/OCR，生成可引用区域。";
}

export function legacyMediaPlaceholder(note?: string): boolean {
  return Boolean(note && (note.includes("降级占位") || note.includes("待接入本地")));
}

export function needsMaterialConfig(note?: string): boolean {
  return Boolean(note && (note.includes("请先配置") || note.includes("未配置") || note.includes("授权") || note.includes("白名单") || note.includes("拦截")));
}

export function materialListStatus(m: ApiMaterial): { text: string; color: string } {
  if (m.status === "pending") {
    return {
      text: isMediaModality(m.modality) ? (needsMaterialConfig(m.note) ? "需配置后加工" : "待开始加工") : "未生成文本",
      color: STATUS_LABELS.pending.color,
    };
  }
  if (m.status === "failed") {
    const note = m.note ?? "";
    return {
      text: note.includes("配置") || note.includes("授权") ? "需配置后重试" : "加工失败",
      color: STATUS_LABELS.failed.color,
    };
  }
  return STATUS_LABELS[m.status];
}

/** 媒体素材加工状态行文案（含部分失败 note，二期 P2.3a/b）。 */
export function mediaStatusText(content: MaterialContent): string {
  const mt = content.material;
  if (mt.status === "processing") return mt.note ?? "加工中：后台正在处理，完成后自动刷新";
  if (mt.status === "pending") return legacyMediaPlaceholder(mt.note) ? mediaPendingText(mt.modality) : (mt.note ?? mediaPendingText(mt.modality));
  if (mt.status === "failed") return mt.note ?? "加工失败。请检查识别服务配置后点击「重试加工」。";
  const eng = `引擎 ${mt.engine ?? "—"}`;
  const dur = mt.duration ? ` · ${mt.duration}s` : "";
  const warn = mt.note ? ` · 警告：${mt.note}` : "";
  if (mt.modality === "audio") return `转写完成 · ${content.segments?.length ?? 0} 段 · ${eng}${dur}${warn}`;
  if (mt.modality === "video" && content.media?.kind === "video") return `解析完成 · ${content.media.shots.length} 镜头 · ${eng}${dur}${warn}`;
  return `解析完成 · ${eng}${warn}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 回听被引用的音频片段（硬验收，二期 §6）：拉原始素材（带令牌）→ 跳播到时间码区间。
 * 用独立 Audio 元素，到段尾即停；调用方无需管理生命周期。
 */
export async function playCitedSegment(materialId: string, timecode: string): Promise<void> {
  const tc = parseTimecode(timecode);
  if (!tc) return;
  let url: string;
  try {
    url = await fetchMaterialRawUrl(materialId);
  } catch {
    return; // 回放加载失败（无内联 UI 上下文）：静默放弃，不抛未处理拒绝。
  }
  const audio = new Audio(url);
  // 单次 revoke 守卫：到段尾 / 自然结束 / 出错 / 播放被拒，任一终态都释放 blob，杜绝泄漏。
  let revoked = false;
  const release = () => {
    if (!revoked) {
      revoked = true;
      URL.revokeObjectURL(url);
    }
  };
  audio.addEventListener("loadedmetadata", () => {
    audio.currentTime = tc[0];
    void audio.play().catch(release);
  });
  audio.addEventListener("timeupdate", () => {
    if (audio.currentTime >= tc[1]) {
      audio.pause();
      release();
    }
  });
  audio.addEventListener("ended", release);
  audio.addEventListener("error", release);
}

export function resolveFocusSpan(text: string, start: number, end: number, quote: string): { start: number; end: number } | null {
  const hasOffset = Number.isFinite(start) && Number.isFinite(end) && end > start;
  const safeStart = hasOffset ? Math.max(0, Math.min(start, text.length)) : 0;
  const safeEnd = hasOffset ? Math.max(safeStart, Math.min(end, text.length)) : 0;
  const trimmedQuote = quote.trim();
  if (trimmedQuote) {
    const offsetText = hasOffset ? text.slice(safeStart, safeEnd) : "";
    if (offsetText && (offsetText.includes(trimmedQuote) || trimmedQuote.includes(offsetText))) {
      return { start: safeStart, end: safeEnd };
    }
    const found = text.indexOf(trimmedQuote);
    if (found >= 0) return { start: found, end: found + trimmedQuote.length };
  }
  return hasOffset ? { start: safeStart, end: safeEnd } : null;
}

export const ELEMENT_TYPE_LABELS = {
  person: "人物",
  org: "组织",
  location: "地点",
  event: "事件",
  equipment: "装备",
  time: "时间",
};

export const ELEMENT_TYPES: (keyof typeof ELEMENT_TYPE_LABELS)[] = ["person", "org", "location", "event", "equipment", "time"];

export const TYPE_COLORS: Record<keyof typeof ELEMENT_TYPE_LABELS, string> = {
  person: "#7dd3fc",       // 哑光天蓝
  org: "#c084fc",          // 哑光柔紫
  location: "#86efac",     // 哑光薄荷绿
  event: "#fed7aa",        // 哑光柔橙
  equipment: "#fca5a5",    // 哑光柔粉
  time: "#fef08a",         // 哑光软黄
};

export function compactElementName(name: string, max = 24): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

export const GRAPH_MIN_EDGES = 12;
export const GRAPH_EDGE_STEP = 6;

export function mentionSources(el: ApiElement): string {
  return [...new Set(el.mentions.map((m) => m.material_name))].join("、");
}

export const REPORT_STATUS_LABELS: Record<ApiReport["status"], string> = {
  draft: "草稿",
  in_review: "待复核",
  approved: "已复核",
  exported: "已导出",
};

export interface StatusTile {
  main: string;
  hint: string;
}

/**
 * 三态区块 → 展示用 tile：loading/error（外层 LoadState）与 not_started/error（内层
 * StatusSection）统一折叠成 { main, hint }；error 与 not_started 绝不显示假 0 值。
 */
export function statusTile<T>(
  page: LoadState<CaseStatusPayload>,
  pick: (data: CaseStatusPayload) => StatusSection<T>,
  render: (value: StatusSection<T> & { state: "ready" }) => StatusTile,
): StatusTile {
  if (page.status === "loading") return { main: "…", hint: "加载中" };
  if (page.status === "error") return { main: "—", hint: `状态不可读取：${page.message}` };
  const section = pick(page.data);
  if (section.state === "error") return { main: "—", hint: `状态不可读取：${section.message}` };
  if (section.state === "not_started") return { main: "未开始", hint: "" };
  return render(section);
}

export const CONTRADICTION_SCOPE_LABELS = {
  "cross-material": "跨文件",
  "intra-material": "文件内",
};

export const REPORT_STEPS: { status: ApiReport["status"]; label: string; hint: string }[] = [
  { status: "draft", label: "草稿起草", hint: "编辑标题与正文，保存即落盘并渲染公文" },
  { status: "in_review", label: "待保密员复核", hint: "提交后由保密员/管理员核对密级与完整性" },
  { status: "approved", label: "已复核", hint: "复核通过，方可导出" },
  { status: "exported", label: "已导出", hint: "导出留存（动作入审计）" },
];

export const GATE_REASON_GLOSSES: Record<string, string> = {
  "coverage:uncited-fact": "存在无引用支撑的事实性内容",
  "coverage:body-unsupported": "正文未逐字复述所选已核准结论",
  "citation:no-span": "引用缺少有效原文定位",
  "citation:invalid": "引用无法匹配当前素材原文",
  "finding:missing": "报告引用的核验池条目不存在",
  "finding:rejected": "报告引用了已驳回核验池条目",
  "finding:not-approved": "报告引用了未核准核验池条目",
  "contradiction:high-severity-unresolved": "存在未处理的高置信矛盾",
};

export function gateReasonGloss(reason: string): string {
  return GATE_REASON_GLOSSES[reason] ?? "导出闸门未通过";
}

export function specToBody(report: ApiReport | null): string {
  if (!report) return "";
  return report.spec.sections.map((s) => (s.heading ? `${s.heading}\n${s.body}` : s.body)).join("\n\n");
}
