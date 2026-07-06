import { useEffect, useState } from "react";
import { fetchFrameUrl, fetchMaterialRawUrl } from "../../../api";

export interface BBox {
  bbox: [number, number, number, number];
  label?: string;
}

export function BboxImage({ materialId, frameT, boxes }: { materialId: string; frameT?: number | string; boxes: BBox[] }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let u: string | null = null;
    setUrl(null);
    setError(null);
    const p = frameT !== undefined ? fetchFrameUrl(materialId, frameT) : fetchMaterialRawUrl(materialId);
    p.then((x) => {
      if (alive) {
        u = x;
        setUrl(x);
      } else {
        URL.revokeObjectURL(x);
      }
    }).catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
      if (u) URL.revokeObjectURL(u);
      setUrl(null);
    };
  }, [materialId, frameT]);

  if (!url) return <div style={{ padding: "16px", fontSize: "12px", color: "var(--text-dim)", background: "rgba(16,24,40,0.4)", borderRadius: "var(--radius)" }}>{error ?? "加载帧…"}</div>;
  return (
    <div style={{ position: "relative", display: "inline-block", maxWidth: "100%", lineHeight: 0 }}>
      <img src={url} alt="frame" style={{ maxWidth: "100%", display: "block", borderRadius: "var(--radius)" }} />
      {boxes.map((b, i) => (
        <div
          key={i}
          title={b.label}
          style={{
            position: "absolute",
            left: `${b.bbox[0] * 100}%`,
            top: `${b.bbox[1] * 100}%`,
            width: `${b.bbox[2] * 100}%`,
            height: `${b.bbox[3] * 100}%`,
            border: "2px solid #5ee7a8",
            boxShadow: "0 0 0 1px rgba(0,0,0,0.6)",
            boxSizing: "border-box",
            pointerEvents: "none",
          }}
        />
      ))}
    </div>
  );
}
