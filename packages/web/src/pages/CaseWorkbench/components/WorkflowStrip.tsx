import { useCallback, useState } from "react";
import { confirmWorkflowCheckpoint, type WorkflowState, type WorkflowStep, type WorkflowStepStatus } from "../../../api";
import { useWorkbenchContext } from "../../CaseWorkbench";
import { useExtractionJob } from "../hooks/useExtractionJob";

type ExtractionJob = ReturnType<typeof useExtractionJob>;

const WORKFLOW_STEP_LABELS: Record<WorkflowStepStatus, string> = {
  idle: "未开始",
  running: "进行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const CHECKPOINT_LABELS: Record<"entities" | "contradictions", string> = {
  entities: "要素检查点",
  contradictions: "矛盾检查点",
};

function formatTs(ts?: string): string {
  return ts ? ts.replace("T", " ").slice(0, 19) : "";
}

/** 复用现有 .task-stage--* 视觉（active/done/failed/skipped）；idle/running 落到既有色系。 */
function stageToneClass(status: WorkflowStepStatus): string {
  if (status === "succeeded") return "done";
  if (status === "cancelled") return "skipped";
  if (status === "running") return "active";
  return status; // idle | failed
}

/**
 * 流程状态条（取代 TaskOverview）：三步骤徽章（要素抽取/矛盾检测/自动研判，含失败重跑）+
 * 两个检查点（要素/矛盾，已确认显示确认人时间，未确认且步骤已完成时可确认）+ 自动研判进度条。
 * 数据完全来自 CaseWorkbench 下发的 status（单一状态源），本组件不自行拉取 workflow。
 */
export function WorkflowStrip({ caseId, canManage, autoInquiryJob }: { caseId: string; canManage: boolean; autoInquiryJob: ExtractionJob }) {
  const { status, refreshStatus } = useWorkbenchContext();
  const [confirming, setConfirming] = useState<"entities" | "contradictions" | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const onElementsDone = useCallback(() => refreshStatus(), [refreshStatus]);
  const onContradictionsDone = useCallback(() => refreshStatus(), [refreshStatus]);
  const elementsJob = useExtractionJob(caseId, "elements", onElementsDone);
  const contradictionsJob = useExtractionJob(caseId, "contradictions", onContradictionsDone);

  const handleRerun = async (job: ExtractionJob) => {
    if (!canManage) return;
    await job.start();
    refreshStatus();
  };

  const handleConfirm = async (key: "entities" | "contradictions") => {
    if (!canManage || confirming) return;
    setConfirming(key);
    setConfirmError(null);
    try {
      await confirmWorkflowCheckpoint(caseId, key);
      refreshStatus();
    } catch (e) {
      setConfirmError((e as Error).message);
    } finally {
      setConfirming(null);
    }
  };

  if (status.status === "loading") {
    return (
      <section className="task-overview">
        <div className="task-overview__eyebrow">流程状态加载中…</div>
      </section>
    );
  }
  if (status.status === "error") {
    return (
      <section className="task-overview">
        <div className="task-overview__error">状态不可读取：{status.message}</div>
      </section>
    );
  }

  const wf = status.data.workflow;
  if (wf.state === "error") {
    return (
      <section className="task-overview">
        <div className="task-overview__error">状态不可读取：{wf.message}</div>
      </section>
    );
  }
  if (wf.state === "not_started") {
    return (
      <section className="task-overview">
        <div className="task-overview__eyebrow">流程尚未开始，请先汇入并加工素材。</div>
      </section>
    );
  }

  const workflow: WorkflowState = wf.data;
  const steps = workflow.steps;
  const stepDefs: { key: "elements" | "contradictions" | "inquiries"; label: string; step: WorkflowStep; job: ExtractionJob | null }[] = [
    { key: "elements", label: "要素抽取", step: steps.elements, job: elementsJob },
    { key: "contradictions", label: "矛盾检测", step: steps.contradictions, job: contradictionsJob },
    { key: "inquiries", label: "自动研判", step: steps.inquiries, job: autoInquiryJob },
  ];

  return (
    <section className="task-overview">
      <div className="task-stage-strip">
        {stepDefs.map(({ key, label, step, job }) => (
          <div key={key} className={`task-stage task-stage--${stageToneClass(step.status)}`}>
            <div className="task-stage__top">
              <span className="task-stage__status">{WORKFLOW_STEP_LABELS[step.status]}</span>
            </div>
            <span className="task-stage__name">{label}</span>
            {step.status === "failed" ? <span className="task-stage__hint">{step.error ?? "运行失败"}</span> : null}
            {step.status === "failed" && canManage && job ? (
              <span className="task-stage__actions">
                <button type="button" onClick={() => void handleRerun(job)} disabled={job.job?.state === "running"}>
                  {job.job?.state === "running" ? "重跑中…" : "重跑"}
                </button>
              </span>
            ) : null}
          </div>
        ))}
      </div>

      <div className="task-overview__checkpoints">
        {(["entities", "contradictions"] as const).map((key) => {
          const approval = workflow.checkpoints[key];
          const relatedStep = key === "entities" ? steps.elements : steps.contradictions;
          return (
            <div key={key} className="task-overview__checkpoint-row">
              <span>{CHECKPOINT_LABELS[key]}</span>
              {approval ? (
                <span>已确认 · {approval.approvedBy} · {formatTs(approval.approvedAt)}</span>
              ) : relatedStep.status === "succeeded" && canManage ? (
                <button type="button" onClick={() => void handleConfirm(key)} disabled={confirming === key}>
                  {confirming === key ? "确认中…" : "确认"}
                </button>
              ) : (
                <span>未确认</span>
              )}
            </div>
          );
        })}
      </div>
      {confirmError ? <div className="task-overview__error">{confirmError}</div> : null}

      {steps.inquiries.items.length > 0 ? (
        <div className="auto-inquiry__bar" aria-label="自动研判进度" aria-hidden="false">
          {steps.inquiries.items.map((item, i) => (
            <span key={i} className={`auto-inquiry__seg auto-inquiry__seg--${item.status}`} title={`${item.question} · ${item.status}`} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
