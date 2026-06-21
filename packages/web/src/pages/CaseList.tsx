import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { listCases, type ApiCase } from "../api";
import { useSession } from "../state/session";
import { CLEARANCE_LABELS } from "../types";

/**
 * 首页 / 专题列表（产品 spec §8.2）。
 * M1：接通 `GET /api/cases`，按当前账户密级过滤（服务端裁剪）。
 */

function statusLabel(status: ApiCase["status"]): { cls: string; text: string } {
  return status === "archived" ? { cls: "", text: "已归档" } : { cls: "ready", text: "进行中" };
}

export function CaseListPage() {
  const { user } = useSession();
  const [cases, setCases] = useState<ApiCase[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    listCases()
      .then((list) => alive && setCases(list))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [user]);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered =
    cases?.filter((c) => {
      if (!normalizedQuery) return true;
      return c.name.toLowerCase().includes(normalizedQuery) || c.owner.toLowerCase().includes(normalizedQuery);
    }) ?? [];

  return (
    <div className="page">
      <div className="page__head">
        <h1 className="page__title">分析专题控制台</h1>
        <div className="page__actions">
          <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
            <svg className="icon-svg" style={{ position: "absolute", left: "12px", color: "var(--text-muted)", pointerEvents: "none" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              className="search"
              type="search"
              placeholder="搜索专题名称 / 负责人..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ paddingLeft: "34px" }}
            />
          </div>
          <Link to="/cases/new" className="btn btn--primary" style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            新建专题
          </Link>
        </div>
      </div>

      {error ? (
        <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: "var(--radius)", padding: "16px 20px", color: "var(--danger-light)" }}>
          专题列表加载失败：{error}
        </div>
      ) : cases === null ? (
        <p style={{ color: "var(--text-dim)" }}>正在加载专题…</p>
      ) : cases.length === 0 ? (
        <div style={{ background: "var(--bg-panel)", padding: "32px 20px", borderRadius: "var(--radius)", border: "1px dashed var(--border)", textAlign: "center", color: "var(--text-dim)" }}>
          <p style={{ fontSize: "15px", marginBottom: "8px" }}>当前密级权限下暂无专题</p>
          <p style={{ fontSize: "13px" }}>点击右上角「新建专题」创建第一个分析专题。</p>
        </div>
      ) : (
        <>
          <h2 style={{ fontSize: "14px", fontWeight: "700", color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "16px" }}>
            活动专题 ({filtered.length})
          </h2>
          {filtered.length === 0 ? (
            <div style={{ background: "var(--bg-panel)", padding: "32px 20px", borderRadius: "var(--radius)", border: "1px dashed var(--border)", textAlign: "center", color: "var(--text-dim)" }}>
              无匹配的专题
            </div>
          ) : (
            <div className="dashboard-grid">
              {filtered.map((c) => {
                const s = statusLabel(c.status);
                return (
                  <div key={c.id} className="case-card">
                    <div className="case-card__header">
                      <span className={`badge badge--clearance tone-${c.clearance}`} style={{ padding: "3px 8px", fontSize: "11px" }}>
                        {CLEARANCE_LABELS[c.clearance]}
                      </span>
                      <span className={`case-card__status ${s.cls}`}>{s.text}</span>
                    </div>

                    <h3 className="case-card__title">{c.name}</h3>
                    <p className="case-card__desc">
                      负责人：{c.owner} · 素材 {c.materials.length} 份
                    </p>

                    <div className="case-card__meta">
                      <span>更新时间: {c.updated_at.slice(0, 10)}</span>
                      <Link to={`/cases/${encodeURIComponent(c.id)}`} className="btn btn--ghost" style={{ padding: "6px 12px", fontSize: "12px", color: "var(--accent-light)", fontWeight: "600", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                        进入工作台
                        <svg className="icon-svg" style={{ width: "12px", height: "12px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="9 18 15 12 9 6"/>
                        </svg>
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
