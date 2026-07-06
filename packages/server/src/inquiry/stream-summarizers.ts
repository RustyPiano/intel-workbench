import type { CitationLedger } from "./intel-harness.js";

/**
 * 补充核验 Agent 的工具事件摘要器（事件协议 v2）。为 tool_start 生成本地化 title 与
 * args_summary，为 tool_result 生成 summary 与 detail（检索类回命中列表、阅读类回文本
 * 预览）。工具 result.content 是 JSON 字符串，解析失败一律降级为通用摘要，绝不抛错。
 */

/** 工具结果明细：检索类给命中列表（snippet ≤120 字符），阅读类给原文预览（≤240 字符）。 */
export type ToolDetail =
  | { kind: "hits"; hits: { material_name: string; snippet: string }[] }
  | { kind: "text"; text: string };

/** 摘要器上下文：素材名映射 + 台账（解析 chunk 归属素材、候选/封卷计数）。 */
export interface SummaryCtx {
  nameById: Map<string, string>;
  ledger: CitationLedger;
}

const HITS_SNIPPET_MAX = 120;
const TEXT_PREVIEW_MAX = 240;
const ERROR_SUMMARY_MAX = 80;
const ARGS_TEXT_MAX = 40;

const TITLES: Record<string, string> = {
  search_chunks: "检索素材片段",
  search_materials: "素材内检索",
  list_materials: "盘点素材",
  read_material_window: "翻阅素材",
  expand_chunk: "展开相邻片段",
  read_chunk: "读取片段全文",
  cite: "登记引用",
  add_claim: "提交结论",
  submit_finding: "提交候选结论",
  finalize_answer: "封卷",
  transcribe: "转写音视频",
  caption_frame: "生成画面描述",
  ocr_region: "识别图像区域",
};

/** 工具本地化标题；未知工具回退为工具名。 */
export function toolTitle(name: string): string {
  return TITLES[name] ?? name;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** query 可为 string 或 string[]（search_materials）：折叠为单串。 */
function queryText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean).join(" ");
  return "";
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function parseArray(content: string): unknown[] {
  const value = parseJson(content);
  return Array.isArray(value) ? value : [];
}

function materialNameForChunk(chunkId: unknown, ctx: SummaryCtx): string {
  const chunk = typeof chunkId === "string" ? ctx.ledger.retrieved.get(chunkId) : undefined;
  if (!chunk) return typeof chunkId === "string" ? chunkId : "";
  return ctx.nameById.get(chunk.material_id) ?? chunk.material_id;
}

/** tool_start 的参数摘要（本地化短句）。 */
export function summarizeArgs(name: string, args: Record<string, unknown>, ctx: SummaryCtx): string {
  switch (name) {
    case "search_chunks":
      return `“${queryText(args.query)}” · k=${asNumber(args.k, 6)}`;
    case "search_materials": {
      const mid = asString(args.material_id).trim();
      const scope = mid ? ctx.nameById.get(mid) ?? mid : "全部素材";
      return `“${queryText(args.query)}” · ${scope}`;
    }
    case "list_materials":
      return "";
    case "read_material_window": {
      const name = ctx.nameById.get(asString(args.material_id)) ?? asString(args.material_id);
      const start = asNumber(args.start_chunk, 0);
      const limit = Math.max(1, asNumber(args.limit, 3));
      return `${name} · 第 ${start}–${start + limit - 1} 块`;
    }
    case "expand_chunk":
      return `${materialNameForChunk(args.chunk_id, ctx)} · 前${asNumber(args.before, 1)}后${asNumber(args.after, 1)}`;
    case "read_chunk":
    case "cite":
      return materialNameForChunk(args.chunk_id, ctx);
    case "add_claim":
      return `${truncate(asString(args.text), ARGS_TEXT_MAX)}…`;
    case "submit_finding":
      return `${truncate(asString(args.conclusion), ARGS_TEXT_MAX)}…`;
    case "finalize_answer": {
      const claims = Array.isArray(args.claims) ? args.claims.length : 0;
      return claims > 0 ? `claims=${claims}` : "";
    }
    case "transcribe": {
      const name = ctx.nameById.get(asString(args.material_id)) ?? asString(args.material_id);
      if (typeof args.t0 === "number" && typeof args.t1 === "number") return `${name} · ${args.t0}–${args.t1}s`;
      return name;
    }
    case "caption_frame": {
      const name = ctx.nameById.get(asString(args.material_id)) ?? asString(args.material_id);
      return `${name} · t=${asNumber(args.t, 0)}s`;
    }
    case "ocr_region": {
      const name = ctx.nameById.get(asString(args.material_id)) ?? asString(args.material_id);
      return `${name} · bbox`;
    }
    default:
      return "";
  }
}

/** tool_result 的结果摘要 + 明细（本地化）。ok=false 用错误信息截 80 字符，无明细。 */
export function summarizeResult(
  name: string,
  result: { ok: boolean; content: string },
  ctx: SummaryCtx,
): { summary: string; detail?: ToolDetail } {
  if (!result.ok) {
    return { summary: truncate(result.content, ERROR_SUMMARY_MAX) };
  }
  switch (name) {
    case "search_chunks":
      return summarizeSearchChunks(result.content);
    case "search_materials":
      return summarizeSearchMaterials(result.content);
    case "list_materials":
      return { summary: `${parseArray(result.content).length} 份素材` };
    case "read_material_window":
    case "expand_chunk":
      return summarizeWindow(result.content);
    case "read_chunk":
      return summarizeReadChunk(result.content);
    case "cite":
      return summarizeCite(result.content);
    case "add_claim":
      return summarizeAddClaim(result.content);
    case "submit_finding":
      return summarizeSubmitFinding(result.content, ctx);
    case "finalize_answer":
      return { summary: `${ctx.ledger.finalize?.claims.length ?? 0} 条结论封卷` };
    case "transcribe":
      return summarizeMediaList(result.content, "个转写片段");
    case "ocr_region":
      return summarizeMediaList(result.content, "行文本");
    case "caption_frame":
      return summarizeCaption(result.content);
    default:
      return { summary: "完成" };
  }
}

function summarizeSearchChunks(content: string): { summary: string; detail?: ToolDetail } {
  const hits = parseArray(content) as { material_name?: unknown; snippet?: unknown }[];
  const materials = new Set(hits.map((h) => asString(h.material_name)).filter(Boolean));
  const detail: ToolDetail = {
    kind: "hits",
    hits: hits.map((h) => ({ material_name: asString(h.material_name), snippet: truncate(asString(h.snippet), HITS_SNIPPET_MAX) })),
  };
  return { summary: `${hits.length} 个命中 · ${materials.size} 份素材`, ...(hits.length ? { detail } : {}) };
}

function summarizeSearchMaterials(content: string): { summary: string; detail?: ToolDetail } {
  const matches = parseArray(content) as { material_name?: unknown; before?: unknown; match?: unknown; after?: unknown }[];
  const detail: ToolDetail = {
    kind: "hits",
    hits: matches.map((m) => ({
      material_name: asString(m.material_name),
      snippet: truncate(`${asString(m.before)}${asString(m.match)}${asString(m.after)}`, HITS_SNIPPET_MAX),
    })),
  };
  return { summary: `${matches.length} 处命中`, ...(matches.length ? { detail } : {}) };
}

function summarizeWindow(content: string): { summary: string; detail?: ToolDetail } {
  const obj = parseJson(content) as { chunks?: unknown } | undefined;
  const chunks = Array.isArray(obj?.chunks) ? (obj.chunks as { text?: unknown }[]) : [];
  const preview = truncate(chunks.map((c) => asString(c.text)).join(" ").trim(), TEXT_PREVIEW_MAX);
  return { summary: `读取 ${chunks.length} 个切块`, ...(preview ? { detail: { kind: "text", text: preview } as const } : {}) };
}

function summarizeReadChunk(content: string): { summary: string; detail?: ToolDetail } {
  const bytes = Buffer.byteLength(content, "utf8");
  const summary = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
  return { summary, detail: { kind: "text", text: truncate(content, TEXT_PREVIEW_MAX) } };
}

function summarizeCite(content: string): { summary: string } {
  const citeId = asString((parseJson(content) as { cite_id?: unknown } | undefined)?.cite_id);
  return { summary: citeId ? `${citeId} 已登记` : "已登记" };
}

function summarizeAddClaim(content: string): { summary: string } {
  const obj = parseJson(content) as { claim_index?: unknown; total?: unknown } | undefined;
  const idx = asNumber(obj?.claim_index, 0);
  return { summary: `第 ${idx}/${asNumber(obj?.total, idx)} 条已提交` };
}

function summarizeSubmitFinding(content: string, ctx: SummaryCtx): { summary: string } {
  const idx = asNumber((parseJson(content) as { finding_index?: unknown } | undefined)?.finding_index, ctx.ledger.submittedFindings.length - 1);
  const finding = ctx.ledger.submittedFindings[idx];
  return { summary: `已提交（支持 ${finding?.supporting_cite_ids.length ?? 0} · 反证 ${finding?.opposing_cite_ids.length ?? 0}）` };
}

function summarizeMediaList(content: string, unit: string): { summary: string; detail?: ToolDetail } {
  const arr = parseArray(content) as { snippet?: unknown }[];
  const preview = truncate(arr.map((x) => asString(x.snippet)).join(" ").trim(), TEXT_PREVIEW_MAX);
  return { summary: `${arr.length} ${unit}`, ...(preview ? { detail: { kind: "text", text: preview } as const } : {}) };
}

function summarizeCaption(content: string): { summary: string; detail?: ToolDetail } {
  const preview = truncate(asString((parseJson(content) as { snippet?: unknown } | undefined)?.snippet), TEXT_PREVIEW_MAX);
  return { summary: "1 条描述", ...(preview ? { detail: { kind: "text", text: preview } as const } : {}) };
}
