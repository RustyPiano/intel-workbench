import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { getOverview, type Modality, type OverviewSummary } from "../api";
import { useSession } from "../state/session";
import { CLEARANCE_LABELS, type Clearance } from "../types";

const MODALITIES: Modality[] = ["doc", "audio", "video", "image"];
const MODALITY_LABELS: Record<Modality, string> = {
  doc: "文档",
  audio: "音频",
  video: "视频",
  image: "图像",
};
// 顺序须与服务端 CLEARANCES 一致（packages/server/src/domain/types.ts，由低到高）。
const CLEARANCES: Clearance[] = ["internal", "secret", "confidential", "topsecret"];

function statusLabel(status: "active" | "archived"): { cls: string; text: string } {
  return status === "archived" ? { cls: "", text: "已归档" } : { cls: "ready", text: "进行中" };
}

function formatTime(value: string): string {
  return value.replace("T", " ").slice(0, 19);
}

export function OverviewPage() {
  const { user } = useSession();
  const [overview, setOverview] = useState<OverviewSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    setError(null);
    getOverview()
      .then((result) => alive && setOverview(result))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [user]);

  return (
    <div className="page">
      <div className="page__head">
        <h1 className="page__title">数据总览</h1>
      </div>

      {error ? (
        <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: "var(--radius)", padding: "16px 20px", color: "var(--danger-light)" }}>
          数据总览加载失败：{error}
        </div>
      ) : overview === null ? (
        <p style={{ color: "var(--text-dim)" }}>正在加载数据总览…</p>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "16px", marginBottom: "24px" }}>
            <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "18px" }}>
              <div style={{ color: "var(--text-dim)", fontSize: "12px", marginBottom: "10px" }}>专题</div>
              <div style={{ fontSize: "30px", fontWeight: 800 }}>{overview.caseCount}</div>
              <div style={{ color: "var(--text-muted)", fontSize: "12px", marginTop: "8px" }}>
                进行中 {overview.activeCount} / 已归档 {overview.archivedCount}
              </div>
            </div>
            <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "18px" }}>
              <div style={{ color: "var(--text-dim)", fontSize: "12px", marginBottom: "10px" }}>素材</div>
              <div style={{ fontSize: "30px", fontWeight: 800 }}>{overview.materialCount}</div>
              <div style={{ color: "var(--text-muted)", fontSize: "12px", marginTop: "8px" }}>当前可访问专题合计</div>
            </div>
            <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "18px" }}>
              <div style={{ color: "var(--text-dim)", fontSize: "12px", marginBottom: "10px" }}>要素</div>
              <div style={{ fontSize: "30px", fontWeight: 800 }}>{overview.elementCount}</div>
              <div style={{ color: "var(--text-muted)", fontSize: "12px", marginTop: "8px" }}>已抽取实体与事件</div>
            </div>
            <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "18px" }}>
              <div style={{ color: "var(--text-dim)", fontSize: "12px", marginBottom: "10px" }}>矛盾</div>
              <div style={{ fontSize: "30px", fontWeight: 800 }}>{overview.contradictionCount}</div>
              <div style={{ color: "var(--text-muted)", fontSize: "12px", marginTop: "8px" }}>跨素材/素材内矛盾</div>
            </div>
          </div>

          {overview.caseCount === 0 ? (
            <div style={{ background: "var(--bg-panel)", padding: "32px 20px", borderRadius: "var(--radius)", border: "1px dashed var(--border)", textAlign: "center", color: "var(--text-dim)" }}>
              当前密级权限下暂无可统计专题
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "16px", marginBottom: "24px" }}>
                <section style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "18px" }}>
                  <h2 style={{ fontSize: "14px", fontWeight: 700, marginBottom: "14px" }}>素材模态分布</h2>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "12px" }}>
                    {MODALITIES.map((modality) => (
                      <div key={modality} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px", background: "rgba(255,255,255,0.02)" }}>
                        <div style={{ color: "var(--text-dim)", fontSize: "12px", marginBottom: "6px" }}>{MODALITY_LABELS[modality]}</div>
                        <div style={{ fontSize: "20px", fontWeight: 700 }}>{overview.materialsByModality[modality]}</div>
                      </div>
                    ))}
                  </div>
                </section>

                <section style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "18px" }}>
                  <h2 style={{ fontSize: "14px", fontWeight: 700, marginBottom: "14px" }}>密级分布</h2>
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    {CLEARANCES.map((clearance) => (
                      <div key={clearance} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
                        <span className={`badge badge--clearance tone-${clearance}`} style={{ padding: "3px 8px", fontSize: "11px" }}>
                          {CLEARANCE_LABELS[clearance]}
                        </span>
                        <strong>{overview.byClearance[clearance]}</strong>
                      </div>
                    ))}
                  </div>
                </section>
              </div>

              <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden", background: "rgba(0,0,0,0.15)" }}>
                <table className="elements-table">
                  <thead>
                    <tr>
                      <th>专题</th>
                      <th>密级</th>
                      <th>状态</th>
                      <th>素材</th>
                      <th>要素</th>
                      <th>矛盾</th>
                      <th>更新时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.rows.map((row) => {
                      const status = statusLabel(row.status);
                      return (
                        <tr key={row.id}>
                          <td>
                            <Link to={`/cases/${encodeURIComponent(row.id)}`} style={{ color: "var(--accent-light)", fontWeight: 700 }}>
                              {row.name}
                            </Link>
                          </td>
                          <td>
                            <span className={`badge badge--clearance tone-${row.clearance}`} style={{ padding: "3px 8px", fontSize: "11px" }}>
                              {CLEARANCE_LABELS[row.clearance]}
                            </span>
                          </td>
                          <td>
                            <span className={`case-card__status ${status.cls}`}>{status.text}</span>
                          </td>
                          <td>{row.materialCount}</td>
                          <td>{row.elementCount}</td>
                          <td>{row.contradictionCount}</td>
                          <td style={{ fontFamily: "monospace" }}>{formatTime(row.updated_at)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
