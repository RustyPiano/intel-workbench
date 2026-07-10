import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import {
  advanceTaskStage,
  confirmTaskStage,
  createTaskRun,
  getCurrentTaskRun,
  listMaterials,
  type ApiMaterial,
  type ApiTaskRunSnapshot,
  type TaskAdvanceStatus,
} from "../../../api";
import {
  needsMaterialConfig,
  nextTaskAction,
  scrollWorkbenchBodyIntoView,
  stageHint,
  MANUAL_STAGE_KEYS,
  REPORT_STATUS_LABELS,
  TASK_RUN_STORAGE_PREFIX,
  taskStageName,
  TASK_STAGE_TAB_PATHS,
  TASK_STATUS_LABELS,
} from "./helpers";

export function TaskOverview({ caseId, enabled, canManage = true }: { caseId?: string; enabled: boolean; canManage?: boolean }) {
  const [snapshot, setSnapshot] = useState<ApiTaskRunSnapshot | null>(null);
  const [visibleMaterials, setVisibleMaterials] = useState<ApiMaterial[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [advancing, setAdvancing] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !caseId) return;
    let alive = true;
    const storageKey = `${TASK_RUN_STORAGE_PREFIX}${caseId}`;

    const load = async () => {
      try {
        const [next, materialList] = await Promise.all([getCurrentTaskRun(caseId), listMaterials(caseId)]);
        if (next) localStorage.setItem(storageKey, next.run.id);
        else localStorage.removeItem(storageKey);
        if (!alive) return;
        setSnapshot(next);
        setVisibleMaterials(materialList);
        setError(null);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };

    void load();
    const timer = setInterval(() => {
      void load();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [caseId, enabled]);

  const handleStart = async () => {
    if (!caseId || !canManage || creating) return;
    setCreating(true);
    setError(null);
    try {
      const next = await createTaskRun(caseId);
      localStorage.setItem(`${TASK_RUN_STORAGE_PREFIX}${caseId}`, next.run.id);
      setSnapshot(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleConfirm = async () => {
    const current = snapshot?.overview.currentStage;
    if (!caseId || !canManage || !snapshot || !current?.checkpoint || confirming) return;
    setConfirming(true);
    setError(null);
    try {
      const next = await confirmTaskStage(caseId, snapshot.run.id, current.key);
      localStorage.setItem(`${TASK_RUN_STORAGE_PREFIX}${caseId}`, next.run.id);
      setSnapshot(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setConfirming(false);
    }
  };

  const handleAdvance = async (stageKey: string, status: TaskAdvanceStatus) => {
    if (!caseId || !canManage || !snapshot || advancing) return;
    const key = `${stageKey}:${status}`;
    setAdvancing(key);
    setError(null);
    try {
      const next = await advanceTaskStage(caseId, snapshot.run.id, stageKey, status);
      localStorage.setItem(`${TASK_RUN_STORAGE_PREFIX}${caseId}`, next.run.id);
      setSnapshot(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdvancing(null);
    }
  };

  if (!enabled) return null;
  const overview = snapshot?.overview;
  const currentStage = overview?.currentStage;
  const stages = snapshot?.run.stages ?? [];
  const progressText = overview ? `${overview.completedStageCount}/${overview.totalStageCount}` : "—";
  const pendingNeedsConfig = visibleMaterials
    ? visibleMaterials.filter((m) => m.status === "pending" && needsMaterialConfig(m.note)).length
    : overview?.materials.needsConfig ?? 0;
  const pendingOtherMaterials = overview ? Math.max(0, overview.materials.pending - pendingNeedsConfig) : 0;
  const materialText = overview
    ? [
      `${overview.materials.done}/${overview.materials.total} 完成`,
      overview.materials.processing > 0 ? `${overview.materials.processing} 加工中` : "",
      pendingNeedsConfig > 0 ? `${pendingNeedsConfig} 需配置` : "",
      pendingOtherMaterials > 0 ? `${pendingOtherMaterials} 待处理` : "",
      overview.materials.failed > 0 ? `${overview.materials.failed} 失败` : "",
    ].filter(Boolean).join("，")
    : "加载中";
  const reportText = overview?.reportStatus ? REPORT_STATUS_LABELS[overview.reportStatus] : "未生成";
  const currentText = snapshot
    ? snapshot.run.status === "active"
      ? taskStageName(currentStage) || "进行中"
      : snapshot.run.status === "done"
        ? "流程完成"
        : "流程失败"
    : "尚未开始";
  const actionText = nextTaskAction(snapshot, creating, confirming);
  const actionHint = snapshot?.run.status === "done"
    ? "所有阶段已完成，后续可在报告复核页查看或重新导出。"
    : snapshot?.run.status === "failed"
      ? "处理失败阶段后可以重新启动核验任务。"
      : stageHint(currentStage);
  const currentStagePath = currentStage ? TASK_STAGE_TAB_PATHS[currentStage.key] : null;

  return (
    <section className="task-overview">
      <div className="task-overview__head">
        <div>
          <div className="task-overview__eyebrow">{snapshot?.template.name ?? "多源事件核验"}</div>
          <div className="task-overview__current">{currentText}</div>
          {snapshot?.run.status === "failed" && snapshot.run.failureReason ? (
            <div style={{ color: "var(--danger-light)", fontSize: "12px", marginTop: "4px" }}>失败阶段：{snapshot.run.failureReason}</div>
          ) : null}
        </div>
        <div className="task-overview__summary">
          <span>{progressText}</span>
          <span>{overview ? overview.pendingCheckpointCount > 0 ? `${overview.pendingCheckpointCount} 个检查点待确认` : "检查点完成" : "等待启动"}</span>
        </div>
      </div>

      <div className="task-overview__metrics">
        <span>素材 {materialText}</span>
        <span>高风险矛盾 {overview?.highSeverityContradictionCount ?? 0}</span>
        <span>报告 {reportText}</span>
      </div>

      <div className="task-next">
        <div>
          <span className="task-next__label">现在要做</span>
          <strong>{actionText}</strong>
          <small>{actionHint}</small>
        </div>
        <div className="task-next__actions">
          {currentStagePath ? (
            <NavLink to={currentStagePath} className="btn" style={{ padding: "6px 12px", fontSize: "12px" }} onClick={scrollWorkbenchBodyIntoView}>
              去对应板块
            </NavLink>
          ) : null}
          {!snapshot && canManage ? (
            <button type="button" className="btn btn--primary" onClick={handleStart} disabled={creating}>
              {creating ? "启动中…" : "开始核验任务"}
            </button>
          ) : null}
          {canManage && currentStage?.checkpoint && currentStage.status === "active" ? (
            <button type="button" className="btn btn--primary" onClick={handleConfirm} disabled={confirming}>
              {confirming ? "确认中…" : "确认检查点"}
            </button>
          ) : null}
        </div>
      </div>

      <div className="task-stage-strip" aria-label="任务阶段进度">
        {stages.map((stage, index) => (
          <div key={stage.key} className={`task-stage task-stage--${stage.status}`} title={`${index + 1}. ${taskStageName(stage)} · ${TASK_STATUS_LABELS[stage.status]}`}>
            <div className="task-stage__top">
              <span className="task-stage__index">{index + 1}</span>
              <span className="task-stage__status">{TASK_STATUS_LABELS[stage.status]}</span>
            </div>
            <span className="task-stage__name">{taskStageName(stage)}</span>
            <span className="task-stage__hint">{stageHint(stage)}</span>
            {stage.checkpoint ? <span className="task-stage__checkpoint">需人工确认</span> : null}
            {canManage && stage.status === "active" && MANUAL_STAGE_KEYS.has(stage.key) ? (
              <span className="task-stage__actions">
                <button type="button" onClick={() => void handleAdvance(stage.key, "done")} disabled={Boolean(advancing)}>
                  {advancing === `${stage.key}:done` ? "处理中…" : "标记完成"}
                </button>
                <button type="button" onClick={() => void handleAdvance(stage.key, "failed")} disabled={Boolean(advancing)}>
                  {advancing === `${stage.key}:failed` ? "处理中…" : "标记失败"}
                </button>
              </span>
            ) : null}
          </div>
        ))}
      </div>

      <div className="task-overview__footer">
        {error ? <span className="task-overview__error">{error}</span> : null}
      </div>
    </section>
  );
}
