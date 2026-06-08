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
    Promise.all([listAudit(user), verifyAudit(user)])
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
      const out = await exportAudit(user);
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
            <span>{verify?.ok ? "✓" : "⚠️"}</span>
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
            <span>{alertCount > 0 ? "⚠️" : "○"}</span>
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
        <button type="button" className="btn" onClick={() => void handleExport()} style={{ padding: "6px 14px", fontSize: "12px" }}>
          📥 导出全量留存
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
