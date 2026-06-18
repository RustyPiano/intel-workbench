import { useEffect, useState } from "react";

import { exportAudit, listAudit, verifyAudit, type AuditEvent, type VerifyResult } from "../api";
import { useSession } from "../state/session";

/**
 * 审计中心（产品 spec §8.15）。保密员/管理员只读。
 * M1：接通 `GET /api/audit`（事件表）+ `GET /api/audit/verify`（哈希链校验，红线）。
 * 筛选与导出留存在 M5 完善。
 */

type Filter = "all" | "alert";

function isAlert(e: AuditEvent): boolean {
  return e.result !== "ok";
}

function shortHash(h: string): string {
  return h.length > 16 ? `${h.slice(0, 7)}…${h.slice(-6)}` : h;
}

function caseIdOf(e: AuditEvent): string {
  const fromDetail = e.detail?.caseId;
  if (typeof fromDetail === "string") return fromDetail;
  return e.object.startsWith("case:") ? e.object.slice("case:".length) : "—";
}

export function AuditCenterPage() {
  const { user } = useSession();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    if (!user) return;
    let alive = true;
    Promise.all([listAudit(), verifyAudit()])
      .then(([evts, v]) => {
        if (!alive) return;
        setEvents(evts);
        setVerify(v);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [user]);

  if (error) {
    return (
      <div className="page">
        <h1 className="page__title">审计中心安全控制台</h1>
        <div style={{ marginTop: "16px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: "var(--radius)", padding: "16px 20px", color: "var(--danger-light)" }}>
          审计数据加载失败：{error}
        </div>
      </div>
    );
  }

  const alertCount = events?.filter(isAlert).length ?? 0;
  const rows = (events ?? []).filter((e) => (filter === "alert" ? isAlert(e) : true)).slice().reverse();
  const lastHash = events && events.length > 0 ? events[events.length - 1].event_hash : null;

  const handleExport = async () => {
    if (!user) return;
    try {
      const out = await exportAudit();
      const blob = new Blob([JSON.stringify(out.events, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-export-${out.exportedAt.slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="page">
      <div className="page__head">
        <h1 className="page__title">审计中心安全控制台</h1>
      </div>

      {/* 完整性校验 + 告警概览 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "20px" }}>
        <div style={{ background: verify?.ok ? "rgba(16, 185, 129, 0.08)" : "rgba(239, 68, 68, 0.08)", border: `1px solid ${verify?.ok ? "rgba(16, 185, 129, 0.25)" : "rgba(239, 68, 68, 0.25)"}`, borderRadius: "var(--radius)", padding: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: verify?.ok ? "var(--ok-light)" : "var(--danger-light)", fontWeight: "700", fontSize: "14px" }}>
            <span>
              {verify === null ? (
                <svg className="icon-svg" style={{ color: "var(--text-muted)", animation: "spin 1s linear infinite" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
                </svg>
              ) : verify.ok ? (
                <svg className="icon-svg" style={{ color: "var(--ok-light)", width: "16px", height: "16px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              ) : (
                <svg className="icon-svg" style={{ color: "var(--danger-light)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
              )}
            </span>
            {verify === null ? "正在校验审计链…" : verify.ok ? "全局审计哈希链完整性校验通过" : `哈希链校验失败：第 ${verify.brokenAt} 条断链`}
          </div>
          <p style={{ fontSize: "12px", color: "var(--text-dim)", marginTop: "6px", lineHeight: "1.5" }}>
            {verify === null
              ? "重算 payload_hash / event_hash 全链中…"
              : verify.ok
                ? <>共 {verify.count} 条事件，append-only 哈希链无断层。{lastHash ? <>最近块：<code style={{ color: "#fff", fontFamily: "monospace" }}>{shortHash(lastHash)}</code></> : null}</>
                : verify.reason}
          </p>
        </div>

        <div style={{ background: alertCount > 0 ? "rgba(239, 68, 68, 0.08)" : "rgba(255,255,255,0.03)", border: `1px solid ${alertCount > 0 ? "rgba(239, 68, 68, 0.25)" : "var(--border)"}`, borderRadius: "var(--radius)", padding: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: alertCount > 0 ? "var(--danger-light)" : "var(--text-dim)", fontWeight: "700", fontSize: "14px" }}>
            <span>
              {alertCount > 0 ? (
                <svg className="icon-svg" style={{ color: "var(--danger-light)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
              ) : (
                <svg className="icon-svg" style={{ color: "var(--text-muted)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                </svg>
              )}
            </span>
            {alertCount > 0 ? `发现拒止/异常类事件 (${alertCount})` : "无拒止/异常类事件"}
          </div>
          <p style={{ fontSize: "12px", color: "var(--text-dim)", marginTop: "6px", lineHeight: "1.5" }}>
            {alertCount > 0
              ? "结果为 deny/error 的事件（如越权创建、外发拦截）已在下表高亮。"
              : "当前所有审计事件结果均为 ok。"}
          </p>
        </div>
      </div>

      {/* 筛选 */}
      <div style={{ display: "flex", gap: "12px", marginBottom: "16px" }}>
        <button type="button" className={`btn ${filter === "all" ? "btn--primary" : ""}`} onClick={() => setFilter("all")} style={{ padding: "6px 14px", fontSize: "12px" }}>
          全部审计日志 ({events?.length ?? 0})
        </button>
        <button type="button" className={`btn ${filter === "alert" ? "btn--primary" : ""}`} onClick={() => setFilter("alert")} style={{ padding: "6px 14px", fontSize: "12px", borderColor: "rgba(239,68,68,0.3)", color: filter === "alert" ? "#fff" : "var(--danger-light)" }}>
          仅看拒止/异常 ({alertCount})
        </button>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn" onClick={() => void handleExport()} style={{ padding: "6px 14px", fontSize: "12px", display: "inline-flex", alignItems: "center", gap: "6px" }}>
          <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          导出全量留存
        </button>
      </div>

      {/* 事件表 */}
      <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden", background: "rgba(0,0,0,0.15)" }}>
        <table className="elements-table">
          <thead>
            <tr>
              <th>操作时间</th>
              <th>责任账户</th>
              <th>动作</th>
              <th>关联专题</th>
              <th>结果</th>
              <th>event_hash</th>
            </tr>
          </thead>
          <tbody>
            {events === null ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", color: "var(--text-dim)", padding: "24px" }}>正在加载审计事件…</td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", color: "var(--text-dim)", padding: "24px" }}>暂无审计事件</td>
              </tr>
            ) : (
              rows.map((e) => {
                const alert = isAlert(e);
                return (
                  <tr key={e.id} style={{ background: alert ? "rgba(239, 68, 68, 0.08)" : "transparent" }}>
                    <td style={{ fontFamily: "monospace" }}>{e.ts.replace("T", " ").slice(0, 19)}</td>
                    <td style={{ fontWeight: "600", color: alert ? "var(--danger-light)" : "inherit" }}>{e.user}</td>
                    <td style={{ fontWeight: alert ? "700" : "inherit" }}>{e.action}</td>
                    <td style={{ fontFamily: "monospace", fontSize: "12px" }}>{caseIdOf(e)}</td>
                    <td>
                      <span
                        className="badge"
                        style={{
                          padding: "2px 8px",
                          fontSize: "11px",
                          background: alert ? "var(--danger-glow)" : "var(--ok-glow)",
                          color: alert ? "var(--danger-light)" : "var(--ok-light)",
                          borderColor: alert ? "rgba(239,68,68,0.3)" : "rgba(16,185,129,0.3)",
                        }}
                      >
                        {e.result}
                      </span>
                    </td>
                    <td className="audit-hash" style={{ color: alert ? "var(--danger-light)" : "inherit" }}>{shortHash(e.event_hash)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
