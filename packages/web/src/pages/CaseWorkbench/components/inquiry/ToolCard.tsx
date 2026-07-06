import type { ReactNode } from "react";
import { formatElapsed, type ToolCallVM } from "./runModel";

/** 工具名 → 图标类别（未知工具落到 gear）。 */
const CATEGORY: Record<string, string> = {
  search_chunks: "search",
  search_materials: "search",
  list_materials: "list",
  read_material_window: "doc",
  expand_chunk: "doc",
  read_chunk: "doc",
  cite: "bookmark",
  add_claim: "check",
  submit_finding: "check",
  finalize_answer: "check",
  transcribe: "audio",
  caption_frame: "image",
  ocr_region: "image",
};

function iconPaths(category: string): ReactNode {
  switch (category) {
    case "search":
      return <><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>;
    case "list":
      return <><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></>;
    case "doc":
      return <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>;
    case "bookmark":
      return <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />;
    case "check":
      return <><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>;
    case "audio":
      return <><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /></>;
    case "image":
      return <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></>;
    default:
      return <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1l2.1-2.1M17 7l2.1-2.1" /></>;
  }
}

function ToolIcon({ name }: { name: string }) {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {iconPaths(CATEGORY[name] ?? "gear")}
    </svg>
  );
}

/** 单张工具卡：进行中→原位更新为成功/失败；detail 存在时可展开命中列表或原文预览。 */
export function ToolCard({ tool }: { tool: ToolCallVM }) {
  const statusClass = tool.status === "ok" ? "ok" : tool.status === "failed" ? "fail" : "run";
  const statusText = tool.status === "running" ? "进行中" : formatElapsed(tool.elapsedMs);
  const hasDetail = Boolean(tool.detail && (tool.detail.kind === "hits" ? tool.detail.hits.length > 0 : tool.detail.text.length > 0));

  const header = (
    <>
      <span className="t-icn"><ToolIcon name={tool.name} /></span>
      <span className="t-title">{tool.title}</span>
      <span className="t-args mono" title={tool.argsSummary || undefined}>{tool.argsSummary}</span>
      <span className="t-right">
        {tool.summary ? <span className="t-summary">{tool.summary}</span> : null}
        <span className={`t-status ${statusClass}`}><i />{statusText}</span>
        {hasDetail ? <span className="t-expand-hint">展开</span> : null}
      </span>
    </>
  );

  if (!hasDetail || !tool.detail) {
    return <div className="ev ev-tool"><div className="t-row">{header}</div></div>;
  }

  const detail = tool.detail;
  return (
    <details className="ev ev-tool">
      <summary>{header}</summary>
      <div className="t-detail">
        {detail.kind === "hits"
          ? detail.hits.map((h, i) => (
              <div key={i} className="t-hit">
                <span className="h-mat mono">{h.material_name}</span>
                <span className="h-text">{h.snippet}</span>
              </div>
            ))
          : <div className="t-quote">{detail.text}</div>}
      </div>
    </details>
  );
}
