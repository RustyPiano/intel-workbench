import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { getOverview, type Modality, type OverviewCaseRow, type OverviewSummary } from "../api";
import { useSession } from "../state/session";
import { CLEARANCE_LABELS, type Clearance } from "../types";

const MODALITIES: Modality[] = ["doc", "audio", "video", "image"];
const MODALITY_LABELS: Record<Modality, string> = {
  doc: "文档",
  audio: "音频",
  video: "视频",
  image: "图像",
};
const REPORT_LABELS = {
  draft: "草稿",
  in_review: "待复核",
  approved: "已复核",
  exported: "已导出",
} as const;
// 顺序须与服务端 CLEARANCES 一致（packages/server/src/domain/types.ts，由低到高）。
const CLEARANCES: Clearance[] = ["internal", "secret", "confidential", "topsecret"];

function statusLabel(status: "active" | "archived"): { cls: string; text: string } {
  return status === "archived" ? { cls: "", text: "已归档" } : { cls: "ready", text: "进行中" };
}

function formatTime(value: string): string {
  return value.replace("T", " ").slice(0, 19);
}

function materialProgressText(materials: OverviewCaseRow["materials"], total: number): string {
  const pendingOther = Math.max(0, materials.pending - materials.needsConfig);
  return [
    `完成 ${materials.done}/${total}`,
    materials.processing > 0 ? `加工中 ${materials.processing}` : "",
    materials.needsConfig > 0 ? `需配置 ${materials.needsConfig}` : "",
    pendingOther > 0 ? `待处理 ${pendingOther}` : "",
    materials.failed > 0 ? `失败 ${materials.failed}` : "",
  ].filter(Boolean).join("，");
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
        <div className="overview__error">
          数据总览加载失败：{error}
        </div>
      ) : overview === null ? (
        <p className="overview__loading">正在加载数据总览……</p>
      ) : (
        <>
          <div className="overview__stats-grid">
            <div className="overview__stat-card">
              <div className="overview__stat-label">专题</div>
              <div className="overview__stat-value">{overview.caseCount}</div>
              <div className="overview__stat-sub">
                进行中 {overview.activeCount} / 已归档 {overview.archivedCount}
              </div>
            </div>
            <div className="overview__stat-card">
              <div className="overview__stat-label">素材</div>
              <div className="overview__stat-value">{overview.materialCount}</div>
              <div className="overview__stat-sub">当前可访问专题合计</div>
            </div>
            <div className="overview__stat-card">
              <div className="overview__stat-label">要素</div>
              <div className="overview__stat-value">{overview.elementCount}</div>
              <div className="overview__stat-sub">已抽取实体与事件</div>
            </div>
            <div className="overview__stat-card">
              <div className="overview__stat-label">矛盾</div>
              <div className="overview__stat-value">{overview.contradictionCount}</div>
              <div className="overview__stat-sub">跨素材/素材内矛盾</div>
            </div>
          </div>

          {overview.caseCount === 0 ? (
            <div className="overview__empty">
              当前密级权限下暂无可统计专题
            </div>
          ) : (
            <>
              <div className="overview__distributions-grid">
                <section className="overview__section-card">
                  <h2 className="overview__section-title">素材模态分布</h2>
                  <div className="overview__modalities-grid">
                    {MODALITIES.map((modality) => (
                      <div key={modality} className="overview__modality-card">
                        <div className="overview__modality-label">{MODALITY_LABELS[modality]}</div>
                        <div className="overview__modality-value">{overview.materialsByModality[modality]}</div>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="overview__section-card">
                  <h2 className="overview__section-title">密级分布</h2>
                  <div className="overview__clearances-list">
                    {CLEARANCES.map((clearance) => (
                      <div key={clearance} className="overview__clearance-row">
                        <span className={`badge badge--clearance tone-${clearance} overview__badge`}>
                          {CLEARANCE_LABELS[clearance]}
                        </span>
                        <strong>{overview.byClearance[clearance]}</strong>
                      </div>
                    ))}
                  </div>
                </section>
              </div>

              <div className="table-scroll overview__table-container">
                <table className="elements-table">
                  <thead>
                    <tr>
                      <th>专题</th>
                      <th>密级</th>
                      <th>状态</th>
                      <th>素材</th>
                      <th>加工状态</th>
                      <th>要素</th>
                      <th>矛盾</th>
                      <th>报告</th>
                      <th>更新时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.rows.map((row) => {
                      const status = statusLabel(row.status);
                      return (
                        <tr key={row.id}>
                          <td data-label="专题">
                            <Link to={`/cases/${encodeURIComponent(row.id)}`} className="overview__case-link">
                              {row.name}
                            </Link>
                          </td>
                          <td data-label="密级">
                            <span className={`badge badge--clearance tone-${row.clearance} overview__badge`}>
                              {CLEARANCE_LABELS[row.clearance]}
                            </span>
                          </td>
                          <td data-label="状态">
                            <span className={`case-card__status ${status.cls}`}>{status.text}</span>
                          </td>
                          <td data-label="素材">{row.materialCount}</td>
                          <td data-label="加工状态">{materialProgressText(row.materials, row.materialCount)}</td>
                          <td data-label="要素">{row.elementCount}</td>
                          <td data-label="矛盾">{row.contradictionCount}</td>
                          <td data-label="报告">{row.reportStatus ? REPORT_LABELS[row.reportStatus] : "未生成"}</td>
                          <td data-label="更新时间" className="overview__time">{formatTime(row.updated_at)}</td>
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
