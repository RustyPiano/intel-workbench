import { useNavigate, useParams } from "react-router-dom";
import { type ApiCitation, type ApiClaim } from "../../../api";
import { playCitedSegment, supportStatusLabel } from "./helpers";

function docCitationFocus(citation: ApiCitation): string | null {
  const params = new URLSearchParams({ material: citation.material_id });
  const quote = (citation.quote ?? citation.snippet).trim();
  if (quote) params.set("quote", quote.slice(0, 500));
  const chunkStart = citation.locator.char_start;
  if (typeof chunkStart !== "number") return params.toString();
  const quoteStart = typeof citation.quote_char_start === "number" ? citation.quote_char_start : 0;
  const quoteEnd = typeof citation.quote_char_end === "number"
    ? citation.quote_char_end
    : typeof citation.locator.char_end === "number"
      ? citation.locator.char_end - chunkStart
      : quoteStart + citation.snippet.length;
  const start = chunkStart + quoteStart;
  const end = chunkStart + quoteEnd;
  params.set("start", String(start));
  params.set("end", String(end));
  return params.toString();
}

export function CitationChips({ claim, onFrame }: { claim: ApiClaim; onFrame: (c: ApiCitation) => void }) {
  const navigate = useNavigate();
  const { id: caseId } = useParams<{ id: string }>();
  if (claim.citations.length === 0) return null;
  return (
    <span className="citation-list">
      {claim.citations.map((c, i) => {
        // 音频引用带时间码 → 点击回听片段；视频/图像带 bbox/时间码 → 点击取帧框选（硬验收，§4.3/§6）。
        const audioTc = c.modality === "audio" ? c.locator.timecode : undefined;
        const framed = (c.modality === "video" || c.modality === "image") && Boolean(c.locator.bbox || c.locator.timecode);
        const docFocus = c.modality === "doc" && caseId ? docCitationFocus(c) : null;
        const quote = c.quote ?? c.snippet;
        const supportStatus = c.support_status ?? c.support_label;
        const supportLabel = supportStatusLabel(supportStatus);
        const support = supportLabel ? ` · 支持性：${supportLabel}` : "";
        const loc = c.locator.timecode
          ? ` · 时间：${c.locator.timecode}秒${c.locator.speaker ? ` · 说话人：${c.locator.speaker}` : ""}`
          : c.locator.paragraph
            ? ` · 第${c.locator.paragraph}段`
            : "";
        const onClick = audioTc
          ? () => void playCitedSegment(c.material_id, audioTc)
          : framed
            ? () => onFrame(c)
            : docFocus
              ? () => navigate(`/cases/${encodeURIComponent(caseId!)}/materials?${docFocus}`)
              : undefined;
        const hint = audioTc ? "\n（点击回听被引用片段）" : framed ? "\n（点击查看引用帧并框选）" : docFocus ? "\n（点击回到原文片段）" : "";
        const citationContent = (
          <>
            {audioTc ? (
              <svg className="icon-svg" style={{ width: "8px", height: "8px", marginRight: "3px", fill: "currentColor", verticalAlign: "middle" }} viewBox="0 0 24 24" stroke="none">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            ) : framed ? (
              <svg className="icon-svg" style={{ width: "8px", height: "8px", marginRight: "3px", verticalAlign: "middle" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              </svg>
            ) : null}
            引用 {i + 1}
          </>
        );
        return (
          <span key={i} className="citation-item">
            {onClick ? (
              <button
                type="button"
                className="citation"
                title={`${c.material_name}${loc}\n${quote}${support}${hint}`}
                onClick={onClick}
              >
                {citationContent}
              </button>
            ) : (
              <span className="citation" title={`${c.material_name}${loc}\n${quote}${support}${hint}`}>
                {citationContent}
              </span>
            )}
            {supportLabel ? <span className="citation-support">{supportLabel}</span> : null}
            {c.quote ? <span className="citation-quote" title={c.quote}>“{c.quote}”</span> : null}
          </span>
        );
      })}
    </span>
  );
}
