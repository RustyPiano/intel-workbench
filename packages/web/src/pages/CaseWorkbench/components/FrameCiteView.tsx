import { type ApiCitation } from "../../../api";
import { BboxImage } from "./BboxImage";
import { parseTimecode, supportStatusLabel } from "./helpers";

export function FrameCiteView({ cite, onClose }: { cite: ApiCitation; onClose: () => void }) {
  const tc = parseTimecode(cite.locator.timecode);
  const frameT = cite.modality === "video" && tc ? tc[0] : undefined;
  const quote = cite.quote ?? cite.snippet;
  const support = cite.support_status ?? cite.support_label;
  const boxes = cite.locator.bbox ? [{ bbox: cite.locator.bbox, label: quote }] : [];
  const artifactHash = cite.locator.artifact_hash;
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px", background: "rgba(16,24,40,0.5)", display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "12px", color: "var(--text-dim)" }}>
          引用出处：{cite.material_name}
          {cite.locator.timecode ? ` · ${cite.locator.timecode}s` : ""}
        </span>
        <button type="button" className="btn" style={{ padding: "2px 8px", fontSize: "11px", display: "inline-flex", alignItems: "center", gap: "4px" }} onClick={onClose}>
          <svg className="icon-svg" style={{ width: "10px", height: "10px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
          关闭
        </button>
      </div>
      <BboxImage materialId={cite.material_id} frameT={frameT} boxes={boxes} />
      {support ? <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>支持性：{supportStatusLabel(support)}</div> : null}
      <div style={{ fontSize: "12px", color: "var(--text)" }}>{quote}</div>
      {artifactHash ? (
        <button
          type="button"
          title={artifactHash}
          onClick={() => { void navigator.clipboard?.writeText(artifactHash); }}
          style={{ alignSelf: "flex-start", padding: 0, border: 0, background: "transparent", color: "var(--text-muted)", fontSize: "11px", fontFamily: "monospace", cursor: "copy" }}
        >
          帧指纹：{artifactHash.slice(0, 12)}…
        </button>
      ) : null}
    </div>
  );
}
