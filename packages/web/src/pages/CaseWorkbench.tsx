import React, { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useOutletContext, useParams } from "react-router-dom";
import { getCase, getCaseStatus, type ApiCase, type CaseStatusPayload } from "../api";
import { useSession } from "../state/session";
import { CLEARANCE_LABELS, type LoadState } from "../types";
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
  status: LoadState<CaseStatusPayload>;
  /** 手动请求重拉专题状态（写操作成功后、窗口 focus 时调用）；轮询纪律见 CaseWorkbench 内部实现。 */
  refreshStatus: () => void;
}

export function useWorkbenchContext(): WorkbenchContext {
  return useOutletContext<WorkbenchContext>();
}

/** workflow 三步骤（要素/矛盾/自动研判）任一为 running 即视为"进行中"，驱动轮询是否继续。 */
export function hasRunningWorkflowStep(status: LoadState<CaseStatusPayload>): boolean {
  if (status.status !== "ready" || status.data.workflow.state !== "ready") return false;
  const steps = status.data.workflow.data.steps;
  return steps.elements.status === "running" || steps.contradictions.status === "running" || steps.inquiries.status === "running";
}

export function CaseWorkbench() {
  const { id } = useParams<{ id: string }>();
  const { user } = useSession();
  const [caseInfo, setCaseInfo] = useState<ApiCase | null>(null);
  const [status, setStatus] = useState<LoadState<CaseStatusPayload>>({ status: "loading" });
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

  // 状态单一源：仅当 workflow 有步骤 running 时才轮询（约 4s），且上一次请求完成后再安排下一次；
  // 窗口 focus 时补拉一次；写操作方经 refreshStatus() 主动触发（不受轮询节奏限制）。
  const refreshRef = useRef<() => void>(() => {});
  const refreshStatus = useCallback(() => {
    refreshRef.current();
  }, []);

  useEffect(() => {
    if (!user || !id) {
      setStatus({ status: "loading" });
      return;
    }
    let alive = true;
    let timer: number | null = null;
    setStatus({ status: "loading" });

    const poll = async () => {
      try {
        const data = await getCaseStatus(id);
        if (!alive) return;
        setStatus({ status: "ready", data });
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
        if (hasRunningWorkflowStep({ status: "ready", data })) {
          timer = window.setTimeout(() => void poll(), 4000);
        }
      } catch (e) {
        if (!alive) return;
        setStatus({ status: "error", message: (e as Error).message });
      }
    };

    const refresh = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      void poll();
    };
    refreshRef.current = refresh;

    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      refreshRef.current = () => {};
      window.removeEventListener("focus", refresh);
      if (timer !== null) window.clearTimeout(timer);
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

      <VerificationSummary caseInfo={caseInfo} status={status} />

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
          <Outlet key={id} context={{ caseInfo, canManage, status, refreshStatus } satisfies WorkbenchContext} />
        </React.Suspense>
      </div>
    </div>
  );
}
