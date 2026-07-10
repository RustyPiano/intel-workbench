import React, { useEffect, useState } from "react";
import { NavLink, Outlet, useOutletContext, useParams } from "react-router-dom";
import { getCase, type ApiCase } from "../api";
import { useSession } from "../state/session";
import { CLEARANCE_LABELS } from "../types";
import { scrollWorkbenchBodyIntoView } from "./CaseWorkbench/components/helpers";
import { VerificationSummary } from "./CaseWorkbench/components/VerificationSummary";

const TABS: { to: string; label: string }[] = [
  { to: "brief", label: "研判简报" },
  { to: "materials", label: "素材" },
  { to: "elements", label: "要素 / 时间线" },
  { to: "contradictions", label: "矛盾核验" },
  { to: "inquiry", label: "补充核验" },
  { to: "findings", label: "结论核验" },
  { to: "report", label: "报告复核" },
  { to: "audit", label: "审计" },
];

export interface WorkbenchContext {
  caseInfo: ApiCase | null;
  canManage: boolean;
}

export function useWorkbenchContext(): WorkbenchContext {
  return useOutletContext<WorkbenchContext>();
}

export function CaseWorkbench() {
  const { id } = useParams<{ id: string }>();
  const { user } = useSession();
  const [caseInfo, setCaseInfo] = useState<ApiCase | null>(null);
  const canManage = Boolean(user && (user.role === "admin" || caseInfo?.owner === user.id));

  useEffect(() => {
    if (!user || !id) return;
    let alive = true;
    getCase(id)
      .then((c) => alive && setCaseInfo(c))
      .catch(() => alive && setCaseInfo(null));
    return () => {
      alive = false;
    };
  }, [user, id]);

  return (
    <div className="workbench">
      <div className="workbench__head">
        <div className="workbench__title-area">
          <h1 className="workbench__title">专题（本次核验主题）: {caseInfo?.name ?? id}</h1>
          <span className="workbench__status-dot" title="活跃研判中" />
          {caseInfo ? (
            <span className={`badge badge--clearance tone-${caseInfo.clearance}`} style={{ padding: "2px 8px", fontSize: "11px" }}>
              {CLEARANCE_LABELS[caseInfo.clearance]}级
            </span>
          ) : null}
        </div>
        <span className="workbench__hint">
          {caseInfo?.description?.trim()
            ? caseInfo.description
            : "专题是本次核验任务；结论是带原文引用并经人工核准的事实判断；报告是基于已核准结论生成的通报草稿。"}
        </span>
      </div>

      <VerificationSummary caseInfo={caseInfo} caseId={id} enabled={Boolean(user && id)} />

      <nav className="tabs">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} className="tabs__tab" onClick={scrollWorkbenchBodyIntoView}>
            {t.label}
          </NavLink>
        ))}
        <span className="tabs__spacer" />
        {canManage ? (
          <NavLink to="materials" className="btn btn--primary" style={{ padding: "6px 14px", fontSize: "12px" }} onClick={scrollWorkbenchBodyIntoView}>
            + 汇入线索
          </NavLink>
        ) : null}
      </nav>

      <div className="workbench__body">
        {/* 按专题 id 重挂载当前面板：切换专题时彻底隔离各面板的进行中状态
            （任务轮询 / 在途请求 / 问答历史），杜绝跨专题串台。 */}
        <React.Suspense fallback={<div style={{ padding: "32px", color: "var(--text-dim)", fontSize: "14px" }}>加载中…</div>}>
          <Outlet key={id} context={{ caseInfo, canManage } satisfies WorkbenchContext} />
        </React.Suspense>
      </div>
    </div>
  );
}
