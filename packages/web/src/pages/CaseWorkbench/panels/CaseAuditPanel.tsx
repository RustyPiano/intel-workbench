import { useEffect, useState } from "react";
import { NavLink, useParams } from "react-router-dom";
import { listCaseAudit, type AuditEvent } from "../../../api";
import { auditActionLabel, auditResultLabel } from "../../../audit-labels";
import { useSession } from "../../../state/session";

export function CaseAuditPanel() {
  const { id: caseId } = useParams<{ id: string }>();
  const { user } = useSession();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [auditFilter, setAuditFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !caseId) return;
    let alive = true;
    listCaseAudit(caseId)
      .then((es) => alive && setEvents(es))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [user, caseId]);

  const last = events && events.length > 0 ? events[events.length - 1] : null;
  // 倒序：最新动作在前。
  const normalizedAuditFilter = auditFilter.trim().toLowerCase();
  const rows = events
    ? events
      .filter((e) => {
        if (!normalizedAuditFilter) return true;
        return [
          auditActionLabel(e),
          e.action,
          e.object,
          e.user,
          JSON.stringify(e.detail ?? {}),
        ].some((value) => value.toLowerCase().includes(normalizedAuditFilter));
      })
      .slice()
      .reverse()
    : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ background: "rgba(16,24,40,0.3)", border: "1px solid var(--border)", padding: "16px 20px", borderRadius: "var(--radius)" }}>
        <h4 style={{ fontSize: "14px", fontWeight: "700", marginBottom: "4px", display: "inline-flex", alignItems: "center", gap: "6px" }}>
          <svg className="icon-svg" style={{ width: "14px", height: "14px", color: "var(--accent-light)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
          专题审计链完整性校验
        </h4>
        <p style={{ fontSize: "12px", color: "var(--text-dim)", lineHeight: "1.6" }}>
          本专题所有变更会同步到全局审计链。共 <strong style={{ color: "#fff" }}>{events?.length ?? "…"}</strong> 条事件
          {last ? (
            <>
              ；末位指纹 <code style={{ color: "var(--warn-light)", fontFamily: "monospace" }}>{last.event_hash.slice(0, 12)}…{last.event_hash.slice(-6)}</code>
            </>
          ) : null}
          。全局审计链可在审计中心一键校验；专题页展示的是该全局链的本专题镜像。
        </p>
      </div>

      {error ? <div style={{ color: "var(--danger-light)", fontSize: "12px" }}>{error}</div> : null}

      <div className="audit-filters">
        <input className="search audit-filters__input audit-filters__input--wide" value={auditFilter} onChange={(e) => setAuditFilter(e.target.value)} placeholder="按动作 / 对象 / 用户 / 详情过滤" />
        <div className="audit-filters__spacer" />
        <NavLink to="/audit" className="btn" style={{ padding: "6px 14px", fontSize: "12px" }}>
          去全局审计中心
        </NavLink>
      </div>

      <div className="audit-layout">
        <table className="audit-table">
          <thead>
            <tr>
              <th>时间戳</th>
              <th>操作账户</th>
              <th>研判动作</th>
              <th>对象</th>
              <th>执行状态</th>
              <th>防篡改指纹</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const r = auditResultLabel(e);
              return (
                <tr key={e.id}>
                  <td data-label="时间戳" style={{ fontFamily: "monospace" }}>{e.ts.replace("T", " ").slice(0, 19)}</td>
                  <td data-label="操作账户" style={{ fontWeight: "600" }}>{e.user}</td>
                  <td data-label="研判动作">{auditActionLabel(e)}</td>
                  <td data-label="对象" style={{ fontFamily: "monospace", fontSize: "12px", color: "var(--text-dim)" }}>{e.object}</td>
                  <td data-label="执行状态" style={{ color: r.color }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <span className="status-dot" style={{ backgroundColor: "currentColor" }} />
                      <span>{r.text}</span>
                    </span>
                  </td>
                  <td data-label="防篡改指纹" className="audit-hash">{e.event_hash.slice(0, 10)}…{e.event_hash.slice(-6)}</td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", color: "var(--text-muted)", padding: "32px" }}>
                  {events === null ? "加载审计记录…" : events.length === 0 ? "本专题暂无审计事件。" : "无匹配的审计事件。"}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
