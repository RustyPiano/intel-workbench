import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useParams } from "react-router-dom";

import {
  approveReport,
  askInquiryDeep,
  askInquiryStream,
  cancelJob,
  advanceTaskStage,
  confirmTaskStage,
  createTaskRun,
  deleteMaterial,
  draftReport,
  exportReport,
  fetchFrameUrl,
  fetchMaterialRawUrl,
  getCase,
  getElementGraph,
  getJobStatus,
  getMaterialContent,
  getReport,
  getCurrentTaskRun,
  listCaseAudit,
  listContradictions,
  listElements,
  listInquiries,
  listMaterials,
  markReview,
  processMaterial,
  reindexMaterial,
  startJob,
  submitReport,
  uploadMaterial,
  type ApiCase,
  type ApiCitation,
  type ApiClaim,
  type ApiElement,
  type ApiInquiry,
  type ApiInquiryStreamEvent,
  type ApiJob,
  type ApiMaterial,
  type ApiReport,
  type ApiTaskRunSnapshot,
  type ApiTaskStageState,
  type TaskAdvanceStatus,
  type AuditEvent,
  type Contradiction,
  type ContradictionDetectionResult,
  type ElementType,
  type ElementGraph,
  type ImageMedia,
  type MaterialContent,
  type TimelinePoint,
  type VideoMedia,
} from "../api";
import { useSession } from "../state/session";
import { CLEARANCE_LABELS } from "../types";

const TABS: { to: string; label: string }[] = [
  { to: "materials", label: "线索素材" },
  { to: "elements", label: "要素提取" },
  { to: "contradictions", label: "矛盾检测" },
  { to: "inquiry", label: "智能问答" },
  { to: "report", label: "通报起草" },
  { to: "audit", label: "专题审计" },
];

/**
 * 专题工作台外壳（产品 spec §8.4）：顶部标签页 + 子路由内容区。
 * M2：标题/密级取自真实专题 manifest。
 */
export function CaseWorkbench() {
  const { id } = useParams<{ id: string }>();
  const { user } = useSession();
  const [caseInfo, setCaseInfo] = useState<ApiCase | null>(null);

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
          <h1 className="workbench__title">专题工作台: {caseInfo?.name ?? id}</h1>
          <span className="workbench__status-dot" title="活跃研判中" />
          {caseInfo ? (
            <span className={`badge badge--clearance tone-${caseInfo.clearance}`} style={{ padding: "2px 8px", fontSize: "11px" }}>
              {CLEARANCE_LABELS[caseInfo.clearance]}级
            </span>
          ) : null}
        </div>
        <span className="workbench__hint">覆盖素材解析、要素抽取、溯源问答与报告复核全流程，所有研判结论均可回溯至素材原文出处。</span>
      </div>

      <TaskOverview caseId={id} enabled={Boolean(user && id)} />

      <nav className="tabs">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} className="tabs__tab">
            {t.label}
          </NavLink>
        ))}
        <span className="tabs__spacer" />
        <NavLink to="materials" className="btn btn--primary" style={{ padding: "6px 14px", fontSize: "12px" }}>
          + 汇入线索
        </NavLink>
      </nav>

      <div className="workbench__body">
        {/* 按专题 id 重挂载当前面板：切换专题时彻底隔离各面板的进行中状态
            （任务轮询 / 在途请求 / 问答历史），杜绝跨专题串台。 */}
        <Outlet key={id} />
      </div>
    </div>
  );
}

// ==================== Task Overlay ====================

const TASK_RUN_STORAGE_PREFIX = "iw-task-run:";

const TASK_STATUS_LABELS: Record<ApiTaskStageState["status"], string> = {
  pending: "待处理",
  active: "当前",
  done: "完成",
  failed: "失败",
  skipped: "跳过",
};

const REPORT_STATUS_LABELS: Record<ApiReport["status"], string> = {
  draft: "草稿",
  in_review: "待复核",
  approved: "已复核",
  exported: "已导出",
};

const MANUAL_STAGE_KEYS = new Set(["proposition-extraction", "assessment"]);

function TaskOverview({ caseId, enabled }: { caseId?: string; enabled: boolean }) {
  const [snapshot, setSnapshot] = useState<ApiTaskRunSnapshot | null>(null);
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
        const next = await getCurrentTaskRun(caseId);
        if (next) localStorage.setItem(storageKey, next.run.id);
        else localStorage.removeItem(storageKey);
        if (!alive) return;
        setSnapshot(next);
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
    if (!caseId || creating) return;
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
    if (!caseId || !snapshot || !current?.checkpoint || confirming) return;
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
    if (!caseId || !snapshot || advancing) return;
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
  const materialText = overview
    ? `${overview.materials.done}/${overview.materials.total} 完成${overview.materials.processing > 0 ? `，${overview.materials.processing} 加工中` : ""}`
    : "加载中";
  const reportText = overview?.reportStatus ? REPORT_STATUS_LABELS[overview.reportStatus] : "未生成";

  return (
    <section className="task-overview">
      <div className="task-overview__head">
        <div>
          <div className="task-overview__eyebrow">{snapshot?.template.name ?? "多源事件核验"}</div>
          <div className="task-overview__current">{currentStage ? currentStage.name : snapshot ? "流程完成" : "尚未开始"}</div>
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

      <div className="task-stage-strip" aria-label="任务阶段进度">
        {stages.map((stage, index) => (
          <div key={stage.key} className={`task-stage task-stage--${stage.status}`} title={`${index + 1}. ${stage.name} · ${TASK_STATUS_LABELS[stage.status]}`}>
            <span className="task-stage__index">{index + 1}</span>
            <span className="task-stage__name">{stage.name}</span>
            {stage.checkpoint ? <span className="task-stage__checkpoint">检查点</span> : null}
            {stage.status === "active" && MANUAL_STAGE_KEYS.has(stage.key) ? (
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
        {!snapshot ? (
          <button type="button" className="btn btn--primary" style={{ padding: "6px 12px", fontSize: "12px" }} onClick={handleStart} disabled={creating}>
            {creating ? "启动中…" : "开始核验任务"}
          </button>
        ) : null}
        {currentStage?.checkpoint && currentStage.status === "active" ? (
          <button type="button" className="btn btn--primary" style={{ padding: "6px 12px", fontSize: "12px" }} onClick={handleConfirm} disabled={confirming}>
            {confirming ? "确认中…" : "确认检查点"}
          </button>
        ) : null}
        {error ? <span className="task-overview__error">{error}</span> : null}
      </div>
    </section>
  );
}

// ==================== 1. Materials Sub-panel ====================

const MODALITY_LABELS: Record<ApiMaterial["modality"], string> = {
  doc: "文档",
  audio: "音频",
  video: "视频",
  image: "图片",
};

const STATUS_LABELS: Record<ApiMaterial["status"], { text: string; color: string }> = {
  pending: { text: "待加工", color: "var(--warn-light)" },
  processing: { text: "加工中", color: "var(--warn-light)" },
  done: { text: "已完成", color: "var(--ok-light)" },
  failed: { text: "失败", color: "var(--danger-light)" },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isMediaModality(m: ApiMaterial["modality"]): boolean {
  return m === "audio" || m === "video" || m === "image";
}

/** 媒体素材加工状态行文案（含部分失败 note，二期 P2.3a/b）。 */
function mediaStatusText(content: MaterialContent): string {
  const mt = content.material;
  if (mt.status === "processing") return "加工中…";
  if (mt.status !== "done") return mt.note ?? "尚未加工。点击「加工」生成可引用片段（带时间码/坐标）。";
  const eng = `引擎 ${mt.engine ?? "—"}`;
  const dur = mt.duration ? ` · ${mt.duration}s` : "";
  const warn = mt.note ? ` · 警告：${mt.note}` : "";
  if (mt.modality === "audio") return `转写完成 · ${content.segments?.length ?? 0} 段 · ${eng}${dur}${warn}`;
  if (mt.modality === "video" && content.media?.kind === "video") return `解析完成 · ${content.media.shots.length} 镜头 · ${eng}${dur}${warn}`;
  return `解析完成 · ${eng}${warn}`;
}

/** 解析时间码 "start-end"（秒）→ [start, end]（二期 P2.3a）。 */
function parseTimecode(tc?: string): [number, number] | null {
  if (!tc) return null;
  const [a, b] = tc.split("-");
  const s = Number(a);
  if (!Number.isFinite(s)) return null;
  const e = Number(b);
  return [s, Number.isFinite(e) ? e : s];
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

type JobKind = ApiJob["kind"];

function useExtractionJob(
  caseId: string,
  kind: JobKind,
  onDone: () => void,
): { job: ApiJob | null; error: string | null; start: () => void; cancel: () => void } {
  const [job, setJob] = useState<ApiJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const aliveRef = useRef(false);
  const generationRef = useRef(0);
  const jobRef = useRef<ApiJob | null>(null);
  const onDoneRef = useRef(onDone);
  const notifiedDoneJobRef = useRef<string | null>(null);

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  const clearPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const applyJob = useCallback((next: ApiJob) => {
    if (!aliveRef.current) return;
    const previous = jobRef.current;
    jobRef.current = next;
    setJob(next);
    if (next.state === "done") {
      clearPolling();
      if (previous?.state !== "done" && notifiedDoneJobRef.current !== next.id) {
        notifiedDoneJobRef.current = next.id;
        onDoneRef.current();
      }
      return;
    }
    if (next.state === "error" || next.state === "cancelled") {
      clearPolling();
      if (next.state === "error") setError(next.error ?? "任务失败");
    }
  }, [clearPolling]);

  const pollOnce = useCallback(async () => {
    if (!caseId) return;
    const generation = generationRef.current;
    try {
      const next = await getJobStatus(caseId, kind);
      if (!aliveRef.current || generation !== generationRef.current || !next) return;
      applyJob(next);
    } catch (e) {
      if (!aliveRef.current || generation !== generationRef.current) return;
      clearPolling();
      setError((e as Error).message);
    }
  }, [applyJob, caseId, clearPolling, kind]);

  const startPolling = useCallback(() => {
    clearPolling();
    timerRef.current = setInterval(() => {
      void pollOnce();
    }, 2000);
  }, [clearPolling, pollOnce]);

  useEffect(() => {
    aliveRef.current = true;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    clearPolling();
    jobRef.current = null;
    notifiedDoneJobRef.current = null;
    setJob(null);
    setError(null);
    if (caseId) {
      void (async () => {
        try {
          const existing = await getJobStatus(caseId, kind);
          if (!aliveRef.current || generation !== generationRef.current) return;
          if (existing?.state === "running") {
            applyJob(existing);
            startPolling();
          } else if (existing) {
            jobRef.current = existing;
            setJob(existing);
            if (existing.state === "error") setError(existing.error ?? "任务失败");
          }
        } catch (e) {
          if (aliveRef.current && generation === generationRef.current) setError((e as Error).message);
        }
      })();
    }
    return () => {
      aliveRef.current = false;
      clearPolling();
    };
  }, [applyJob, caseId, clearPolling, kind, startPolling]);

  const start = useCallback(() => {
    if (!caseId || jobRef.current?.state === "running") return;
    const generation = generationRef.current;
    void (async () => {
      clearPolling();
      setError(null);
      try {
        const next = await startJob(caseId, kind);
        if (!aliveRef.current || generation !== generationRef.current) return;
        applyJob(next);
        if (next.state === "running") startPolling();
      } catch (e) {
        if (aliveRef.current && generation === generationRef.current) setError((e as Error).message);
      }
    })();
  }, [applyJob, caseId, clearPolling, kind, startPolling]);

  const cancel = useCallback(() => {
    if (!caseId || jobRef.current?.state !== "running") return;
    const generation = generationRef.current;
    void (async () => {
      setError(null);
      try {
        await cancelJob(caseId, kind);
        if (aliveRef.current && generation === generationRef.current && jobRef.current?.state === "running" && !timerRef.current) startPolling();
      } catch (e) {
        if (aliveRef.current && generation === generationRef.current) setError((e as Error).message);
      }
    })();
  }, [caseId, kind, startPolling]);

  return { job, error, start, cancel };
}

/**
 * 回听被引用的音频片段（硬验收，二期 §6）：拉原始素材（带令牌）→ 跳播到时间码区间。
 * 用独立 Audio 元素，到段尾即停；调用方无需管理生命周期。
 */
async function playCitedSegment(materialId: string, timecode: string): Promise<void> {
  const tc = parseTimecode(timecode);
  if (!tc) return;
  let url: string;
  try {
    url = await fetchMaterialRawUrl(materialId);
  } catch {
    return; // 回放加载失败（无内联 UI 上下文）：静默放弃，不抛未处理拒绝。
  }
  const audio = new Audio(url);
  // 单次 revoke 守卫：到段尾 / 自然结束 / 出错 / 播放被拒，任一终态都释放 blob，杜绝泄漏。
  let revoked = false;
  const release = () => {
    if (!revoked) {
      revoked = true;
      URL.revokeObjectURL(url);
    }
  };
  audio.addEventListener("loadedmetadata", () => {
    audio.currentTime = tc[0];
    void audio.play().catch(release);
  });
  audio.addEventListener("timeupdate", () => {
    if (audio.currentTime >= tc[1]) {
      audio.pause();
      release();
    }
  });
  audio.addEventListener("ended", release);
  audio.addEventListener("error", release);
}

interface BBox {
  bbox: [number, number, number, number];
  label?: string;
}

/**
 * 帧图 + bbox 框选（二期 §4.3）。带令牌拉帧（视频=frame 端点按 t，图像=raw 原图）→
 * objectURL → <img>，OCR/引用区域按归一化 [x,y,w,h] 叠加描边框。
 */
function BboxImage({ materialId, frameT, boxes }: { materialId: string; frameT?: number; boxes: BBox[] }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let u: string | null = null;
    const p = frameT !== undefined ? fetchFrameUrl(materialId, frameT) : fetchMaterialRawUrl(materialId);
    p.then((x) => {
      if (alive) {
        u = x;
        setUrl(x);
      } else {
        URL.revokeObjectURL(x);
      }
    }).catch(() => alive && setUrl(null));
    return () => {
      alive = false;
      if (u) URL.revokeObjectURL(u);
      setUrl(null);
    };
  }, [materialId, frameT]);

  if (!url) return <div style={{ padding: "16px", fontSize: "12px", color: "var(--text-dim)", background: "rgba(16,24,40,0.4)", borderRadius: "var(--radius)" }}>加载帧…</div>;
  return (
    <div style={{ position: "relative", display: "inline-block", maxWidth: "100%", lineHeight: 0 }}>
      <img src={url} alt="frame" style={{ maxWidth: "100%", display: "block", borderRadius: "var(--radius)" }} />
      {boxes.map((b, i) => (
        <div
          key={i}
          title={b.label}
          style={{
            position: "absolute",
            left: `${b.bbox[0] * 100}%`,
            top: `${b.bbox[1] * 100}%`,
            width: `${b.bbox[2] * 100}%`,
            height: `${b.bbox[3] * 100}%`,
            border: "2px solid #5ee7a8",
            boxShadow: "0 0 0 1px rgba(0,0,0,0.6)",
            boxSizing: "border-box",
            pointerEvents: "none",
          }}
        />
      ))}
    </div>
  );
}

/** 视频阅读区：分镜（帧+配文+OCR 框选）+ 音轨转写（二期 P2.3b）。 */
function VideoMediaView({ materialId, media }: { materialId: string; media: VideoMedia }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={{ fontSize: "12px", color: "var(--text-dim)" }}>分镜 {media.shots.length} · 时长 {media.duration}s</div>
      {media.shots.map((shot, i) => (
        <div key={i} style={{ display: "flex", gap: "14px", flexWrap: "wrap", padding: "10px", background: "rgba(16,24,40,0.3)", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
          <div style={{ flexShrink: 0, width: "240px", maxWidth: "100%" }}>
            <BboxImage materialId={materialId} frameT={shot.t1} boxes={shot.ocr.map((o) => ({ bbox: o.bbox, label: o.text }))} />
            <div style={{ fontSize: "11px", fontFamily: "monospace", color: "var(--text-muted)", marginTop: "4px" }}>镜头 {shot.t1}–{shot.t2}s</div>
          </div>
          <div style={{ fontSize: "13px", lineHeight: 1.6, flex: 1, minWidth: "180px" }}>
            {shot.caption ? <div><strong style={{ color: "var(--accent-light)" }}>配文：</strong>{shot.caption}</div> : null}
            {shot.ocr.length ? <div style={{ marginTop: "6px" }}><strong style={{ color: "var(--accent-light)" }}>OCR：</strong>{shot.ocr.map((o) => o.text).join(" / ")}</div> : null}
          </div>
        </div>
      ))}
      {media.transcript && media.transcript.segments.length ? (
        <div>
          <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-muted)", margin: "4px 0" }}>音轨转写</div>
          {media.transcript.segments.map((seg, i) => (
            <div key={i} style={{ fontSize: "13px", padding: "3px 0" }}>
              <span style={{ fontFamily: "monospace", color: "var(--text-muted)", marginRight: "8px" }}>{seg.start}–{seg.end}s</span>
              {seg.speaker ? <strong style={{ color: "var(--accent-light)", marginRight: "6px" }}>{seg.speaker}</strong> : null}
              {seg.text}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 引用帧框选（硬验收，二期 §4.3）：bbox/timecode 引用 → 取帧（视频=frame 端点按时间码起点，
 * 图像=原图）并在帧上框出被引用区域，复核员据此核对"区域"而非仅文本。
 */
function FrameCiteView({ cite, onClose }: { cite: ApiCitation; onClose: () => void }) {
  const tc = parseTimecode(cite.locator.timecode);
  const frameT = cite.modality === "video" && tc ? tc[0] : undefined;
  const quote = cite.quote ?? cite.snippet;
  const support = cite.support_status ?? cite.support_label;
  const boxes = cite.locator.bbox ? [{ bbox: cite.locator.bbox, label: quote }] : [];
  const artifactHash = cite.locator.artifact_hash;
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px", background: "rgba(16,24,40,0.5)", display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "12px", color: "var(--text-dim)" }}>
          引用出处：{cite.material_name}
          {cite.locator.timecode ? ` · ${cite.locator.timecode}s` : ""}
        </span>
        <button type="button" className="btn" style={{ padding: "2px 8px", fontSize: "11px", display: "inline-flex", alignItems: "center", gap: "4px" }} onClick={onClose}>
          <svg className="icon-svg" style={{ width: "10px", height: "10px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
          关闭
        </button>
      </div>
      <BboxImage materialId={cite.material_id} frameT={frameT} boxes={boxes} />
      {support ? <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>支持性：{support}</div> : null}
      <div style={{ fontSize: "12px", color: "var(--text)" }}>{quote}</div>
      {artifactHash ? (
        <button
          type="button"
          title={artifactHash}
          onClick={() => { void navigator.clipboard?.writeText(artifactHash); }}
          style={{ alignSelf: "flex-start", padding: 0, border: 0, background: "transparent", color: "var(--text-muted)", fontSize: "11px", fontFamily: "monospace", cursor: "copy" }}
        >
          frame/crop sha256: {artifactHash.slice(0, 12)}…
        </button>
      ) : null}
    </div>
  );
}

/** 图像阅读区：原图 + OCR 区域框选 + 配文（二期 P2.3b）。 */
function ImageMediaView({ materialId, media }: { materialId: string; media: ImageMedia }) {
  return (
    <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
      <div style={{ flexShrink: 0, maxWidth: "360px" }}>
        <BboxImage materialId={materialId} boxes={media.ocr.map((o) => ({ bbox: o.bbox, label: o.text }))} />
      </div>
      <div style={{ fontSize: "13px", lineHeight: 1.7, minWidth: "200px", flex: 1 }}>
        {media.caption ? <div><strong style={{ color: "var(--accent-light)" }}>配文：</strong>{media.caption}</div> : null}
        {media.ocr.length ? (
          <div style={{ marginTop: "8px" }}>
            <strong style={{ color: "var(--accent-light)" }}>OCR：</strong>
            <ul style={{ margin: "4px 0", paddingLeft: "18px" }}>
              {media.ocr.map((o, i) => <li key={i}>{o.text}</li>)}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function MaterialsPanel() {
  const { id: caseId } = useParams<{ id: string }>();
  const { user } = useSession();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [materials, setMaterials] = useState<ApiMaterial[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [content, setContent] = useState<MaterialContent | null>(null);
  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [rawUrl, setRawUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ name: string; index: number; total: number; fraction: number } | null>(null);
  const [uploadIssues, setUploadIssues] = useState<{ name: string; message: string }[]>([]);

  const refresh = () => {
    if (!user || !caseId) return;
    listMaterials(caseId)
      .then((list) => {
        setMaterials(list);
        setActiveId((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch((e: Error) => setError(e.message));
  };

  useEffect(refresh, [user, caseId]);

  useEffect(() => {
    if (!user || !activeId) {
      setContent(null);
      return;
    }
    let alive = true;
    getMaterialContent(activeId)
      .then((c) => alive && setContent(c))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [user, activeId]);

  const handleFiles = async (fileList: FileList | null) => {
    if (!user || !caseId || !fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    setBusy(true);
    setError(null);
    setUploadIssues([]);
    // 逐个文件直传字节（二期 §4.6，绕 25MB base64 上限）；单个失败不拖垮整批，收集后单列。
    const issues: { name: string; message: string }[] = [];
    let firstOk: string | null = null;
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setUploadProgress({ name: file.name, index: i + 1, total: files.length, fraction: 0 });
        try {
          const m = await uploadMaterial(caseId, file, (fraction) =>
            setUploadProgress({ name: file.name, index: i + 1, total: files.length, fraction }),
          );
          if (!firstOk) firstOk = m.id;
        } catch (e) {
          issues.push({ name: file.name, message: (e as Error).message });
        }
      }
    } finally {
      setUploadProgress(null);
      setUploadIssues(issues);
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      refresh();
      if (firstOk) setActiveId(firstOk);
    }
  };

  // 重建稠密索引（embed 端点恢复后）；完成后刷新列表与阅读区。
  const handleReindex = async (mid: string) => {
    if (!user || !caseId || reindexing) return;
    setReindexing(true);
    setError(null);
    try {
      await reindexMaterial(caseId, mid);
      refresh();
      setContent(await getMaterialContent(mid));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReindexing(false);
    }
  };

  // 删除素材（清理落盘 + 从专题摘除）；删当前选中则清空阅读区，列表回落首项。
  const handleDelete = async (mid: string) => {
    if (!user || !caseId || deleting) return;
    if (!window.confirm("确认删除该素材？将一并清除其解析文本、片段与检索索引，此操作不可恢复。")) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteMaterial(caseId, mid);
      if (activeId === mid) {
        setActiveId(null);
        setContent(null);
      }
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  // 显式加工媒体素材（二期 P2.3a）；完成后刷新列表与阅读区。
  const handleProcess = async (mid: string) => {
    if (!user || !caseId || processing) return;
    setProcessing(true);
    setError(null);
    try {
      await processMaterial(caseId, mid);
      refresh();
      setContent(await getMaterialContent(mid));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProcessing(false);
    }
  };

  // done 音频：拉原始素材为对象 URL，供回放（带令牌，故先 fetch 再 objectURL）。
  useEffect(() => {
    if (content?.material.modality !== "audio" || !content.segments) {
      setRawUrl(null);
      return;
    }
    let alive = true;
    let url: string | null = null;
    fetchMaterialRawUrl(content.material.id)
      .then((u) => {
        if (alive) {
          url = u;
          setRawUrl(u);
        } else {
          URL.revokeObjectURL(u);
        }
      })
      .catch(() => alive && setRawUrl(null));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [content]);

  const playSeg = (start: number) => {
    const a = audioRef.current;
    if (a) {
      a.currentTime = start;
      void a.play();
    }
  };

  return (
    <div className="materials-layout">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => void handleFiles(e.target.files)}
      />

      {/* 素材侧栏 */}
      <div className="materials-sidebar">
        <div style={{ padding: "12px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: "12px", fontWeight: "700", color: "var(--text-muted)", textTransform: "uppercase" }}>
            线索素材 ({materials?.length ?? 0})
          </span>
          <button type="button" className="btn btn--primary" style={{ padding: "4px 10px", fontSize: "11px" }} disabled={busy} onClick={() => fileInputRef.current?.click()}>
            {busy ? "汇入中…" : "+ 汇入"}
          </button>
        </div>

        {error ? <div style={{ padding: "12px", fontSize: "12px", color: "var(--danger-light)" }}>{error}</div> : null}

        {uploadProgress ? (
          <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ fontSize: "11px", color: "var(--text-dim)", marginBottom: "5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {uploadProgress.fraction >= 1
                ? `正在解析并建立检索索引… ${uploadProgress.index}/${uploadProgress.total} — ${uploadProgress.name}`
                : `上传中 ${uploadProgress.index}/${uploadProgress.total} · ${Math.round(uploadProgress.fraction * 100)}% — ${uploadProgress.name}`}
            </div>
            <div style={{ height: "4px", background: "rgba(255,255,255,0.1)", borderRadius: "2px", overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${Math.round(uploadProgress.fraction * 100)}%`,
                  background: "var(--accent-light)",
                  transition: "width 0.15s",
                  // 字节已传完、等服务端解析/建索引（大文档 embed 需数十秒）：进度条脉动表示仍在进行。
                  animation: uploadProgress.fraction >= 1 ? "iw-bar-pulse 1.2s ease-in-out infinite" : undefined,
                }}
              />
            </div>
          </div>
        ) : null}

        {uploadIssues.length > 0 ? (
          <div style={{ padding: "10px 12px", fontSize: "11px", color: "var(--danger-light)", borderBottom: "1px solid var(--border)", lineHeight: "1.6" }}>
            {uploadIssues.length} 个文件上传失败（其余已汇入）：
            {uploadIssues.map((it, i) => (
              <div key={i} style={{ marginTop: "2px" }}>· {it.name}：{it.message}</div>
            ))}
          </div>
        ) : null}

        {materials === null ? (
          <div style={{ padding: "16px", fontSize: "13px", color: "var(--text-dim)" }}>加载中…</div>
        ) : materials.length === 0 ? (
          <div style={{ padding: "16px", fontSize: "13px", color: "var(--text-dim)", lineHeight: "1.6" }}>
            暂无素材。点击「+ 汇入」上传线索：支持文档（TXT / Markdown / CSV / JSON / 日志，以及 PDF / Word / PPT / Excel，自动解析），音频、视频与图片可在汇入后进行转写与识别，统一形成可检索、可引用的素材。
          </div>
        ) : (
          materials.map((m) => {
            const s = STATUS_LABELS[m.status];
            return (
              <div key={m.id} className={`materials-item ${activeId === m.id ? "active" : ""}`} onClick={() => setActiveId(m.id)}>
                <div className="materials-item__title">{m.filename}</div>
                <div className="materials-item__meta">
                  <span>{MODALITY_LABELS[m.modality]} · {formatSize(m.size)}</span>
                  <span style={{ color: s.color }}>
                    {s.text}
                    {m.status === "done" && m.chunk_count !== undefined ? ` · ${m.chunk_count} 个片段` : ""}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 内容阅读区 */}
      <div className="materials-viewer">
        {!content ? (
          <div style={{ padding: "32px", color: "var(--text-dim)", fontSize: "14px" }}>
            {materials && materials.length === 0 ? "汇入素材后，可在此查看解析后的原文与可引用片段。" : "选择左侧素材查看内容。"}
          </div>
        ) : (
          <>
            <div className="materials-viewer__header">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
                <div className="materials-viewer__title" style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                  <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                  </svg>
                  {content.material.filename}
                </div>
                <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                  {content.material.status === "done" ? (
                    <button
                      type="button"
                      className="btn"
                      style={{ padding: "4px 10px", fontSize: "11px", display: "inline-flex", alignItems: "center", gap: "4px" }}
                      disabled={reindexing || deleting}
                      onClick={() => void handleReindex(content.material.id)}
                      title="重新生成该素材的语义检索索引"
                    >
                      <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                      </svg>
                      {reindexing ? "重建中…" : "重建索引"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn--danger"
                    style={{ padding: "4px 10px", fontSize: "11px", display: "inline-flex", alignItems: "center", gap: "4px" }}
                    disabled={deleting || reindexing}
                    onClick={() => void handleDelete(content.material.id)}
                  >
                    <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>
                    </svg>
                    {deleting ? "删除中…" : "删除"}
                  </button>
                </div>
              </div>
              <div style={{ fontSize: "12px", color: "var(--text-dim)", marginTop: "4px" }}>
                模态: <strong style={{ color: "#fff" }}>{MODALITY_LABELS[content.material.modality]}</strong> | 格式: {content.material.format} | 大小:{" "}
                {formatSize(content.material.size)} | 汇入: {content.material.ingested_at.replace("T", " ").slice(0, 19)}
                {content.chunkCount !== undefined ? ` | 片段: ${content.chunkCount}` : ""}
              </div>
            </div>

            <div className="materials-viewer__body">
              {isMediaModality(content.material.modality) ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="btn btn--primary"
                      style={{ padding: "6px 14px", fontSize: "12px" }}
                      onClick={() => void handleProcess(content.material.id)}
                      disabled={processing || content.material.status === "processing"}
                    >
                      {processing || content.material.status === "processing" ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                          <svg className="icon-svg" style={{ width: "12px", height: "12px", animation: "spin 1s linear infinite" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
                          </svg>
                          加工中…
                        </span>
                      ) : content.material.status === "done" ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                          <svg className="icon-svg" style={{ width: "12px", height: "12px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                          </svg>
                          重新加工
                        </span>
                      ) : content.material.status === "failed" ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                          <svg className="icon-svg" style={{ width: "12px", height: "12px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
                          </svg>
                          重试加工
                        </span>
                      ) : (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                          <svg className="icon-svg" style={{ width: "12px", height: "12px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="5 3 19 12 5 21 5 3"/>
                          </svg>
                          开始加工
                        </span>
                      )}
                    </button>
                    <span style={{ fontSize: "12px", color: "var(--text-dim)" }}>{mediaStatusText(content)}</span>
                  </div>

                  {content.material.modality === "audio" && content.segments ? (
                    <>
                      {rawUrl ? <audio ref={audioRef} controls src={rawUrl} style={{ width: "100%" }} /> : null}
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        {content.segments.map((seg, i) => (
                          <div
                            key={i}
                            style={{ display: "flex", gap: "10px", alignItems: "flex-start", padding: "8px 10px", background: "rgba(16,24,40,0.3)", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}
                          >
                            <button
                              type="button"
                              className="btn"
                              style={{ padding: "2px 8px", fontSize: "11px", fontFamily: "monospace", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: "4px" }}
                              onClick={() => playSeg(seg.start)}
                              title="回听此段"
                              disabled={!rawUrl}
                            >
                              <svg className="icon-svg" style={{ width: "8px", height: "8px" }} viewBox="0 0 24 24" fill="currentColor">
                                <polygon points="5 3 19 12 5 21 5 3"/>
                              </svg>
                              {fmtTime(seg.start)}
                            </button>
                            <div style={{ fontSize: "13px", lineHeight: "1.6" }}>
                              {seg.speaker ? <strong style={{ color: "var(--accent-light)", marginRight: "6px" }}>{seg.speaker}</strong> : null}
                              {seg.text}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : null}

                  {content.material.modality === "video" && content.media?.kind === "video" ? (
                    <VideoMediaView materialId={content.material.id} media={content.media} />
                  ) : null}

                  {content.material.modality === "image" && content.media?.kind === "image" ? (
                    <ImageMediaView materialId={content.material.id} media={content.media} />
                  ) : null}
                </div>
              ) : content.text !== undefined ? (
                <>
                  {content.material.note ? (
                    <div style={{ background: "rgba(245, 158, 11, 0.08)", border: "1px solid rgba(245, 158, 11, 0.25)", borderRadius: "var(--radius)", padding: "8px 12px", color: "var(--warn-light)", fontSize: "12px", lineHeight: "1.6", marginBottom: "10px", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <svg className="icon-svg" style={{ color: "var(--warn-light)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                      <span>{content.material.note}</span>
                    </div>
                  ) : null}
                  <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit", fontSize: "13px", lineHeight: "1.7", color: "var(--text)", margin: 0 }}>
                    {content.text}
                  </pre>
                </>
              ) : (
                <div style={{ background: "rgba(245, 158, 11, 0.08)", border: "1px solid rgba(245, 158, 11, 0.25)", borderRadius: "var(--radius)", padding: "16px", color: "var(--warn-light)", fontSize: "13px", lineHeight: "1.6" }}>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                    <svg className="icon-svg" style={{ color: "var(--warn-light)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    <strong>{content.note ?? "该素材尚未加工完成。"}</strong>
                  </div>
                  <div style={{ marginTop: "8px", color: "var(--text-dim)" }}>
                    点击上方「开始加工」，对音视频与图像进行转写与识别，生成可引用片段。
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ==================== 2. Elements Sub-panel ====================

const ELEMENT_TYPE_LABELS: Record<ElementType, string> = {
  person: "人物",
  org: "组织",
  location: "地点",
  event: "事件",
  equipment: "装备",
  time: "时间",
};

const ELEMENT_TYPE_ICONS: Record<ElementType, React.ReactNode> = {
  person: (
    <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
    </svg>
  ),
  org: (
    <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><line x1="9" y1="22" x2="9" y2="16"/><line x1="15" y1="22" x2="15" y2="16"/><line x1="9" y1="16" x2="15" y2="16"/><path d="M8 6h2v2H8V6zm0 4h2v2H8v-2zm8-4h2v2h-2V6zm0 4h2v2h-2v-2z"/>
    </svg>
  ),
  location: (
    <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
    </svg>
  ),
  event: (
    <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  ),
  equipment: (
    <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
    </svg>
  ),
  time: (
    <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </svg>
  ),
};

const ELEMENT_TYPES: ElementType[] = ["person", "org", "location", "event", "equipment", "time"];

const TYPE_COLORS: Record<ElementType, string> = {
  person: "#38bdf8",
  org: "#a78bfa",
  location: "#34d399",
  event: "#f59e0b",
  equipment: "#f87171",
  time: "#facc15",
};

function mentionSources(el: ApiElement): string {
  return [...new Set(el.mentions.map((m) => m.material_name))].join("、");
}

export function ElementsPanel() {
  const { id: caseId } = useParams<{ id: string }>();
  const { user } = useSession();
  const [elements, setElements] = useState<ApiElement[] | null>(null);
  const [view, setView] = useState<"list" | "graph" | "timeline">("list");
  const [activeCat, setActiveCat] = useState<ElementType | "all">("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reloadElements = useCallback(() => {
    if (!user || !caseId) return;
    let alive = true;
    listElements(caseId)
      .then((els) => alive && setElements(els))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [user, caseId]);

  useEffect(() => {
    return reloadElements();
  }, [reloadElements]);

  const onElementsDone = useCallback(() => {
    void reloadElements();
  }, [reloadElements]);
  const { job, error: jobError, start: startExtraction, cancel: cancelExtraction } = useExtractionJob(caseId ?? "", "elements", onElementsDone);

  const handleExtract = async () => {
    if (!user || !caseId) return;
    setError(null);
    startExtraction();
  };

  const all = elements ?? [];
  const running = job?.state === "running";
  const total = job?.progress.total ?? 0;
  const done = job?.progress.done ?? 0;
  const progressWidth = running && total > 0 ? `${Math.min(100, Math.round((done / total) * 100))}%` : "38%";
  const filtered = all.filter((e) => {
    const matchCat = activeCat === "all" || e.type === activeCat;
    const q = search.toLowerCase();
    const matchSearch = !q || e.name.toLowerCase().includes(q) || e.aliases.some((a) => a.toLowerCase().includes(q));
    return matchCat && matchSearch;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", minHeight: 0 }}>
      <div style={{ display: "inline-flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className={`btn ${view === "list" ? "btn--primary" : ""}`} style={{ padding: "6px 12px", fontSize: "12px" }} onClick={() => setView("list")}>
          要素列表
        </button>
        <button type="button" className={`btn ${view === "graph" ? "btn--primary" : ""}`} style={{ padding: "6px 12px", fontSize: "12px" }} onClick={() => setView("graph")}>
          关系网络
        </button>
        <button type="button" className={`btn ${view === "timeline" ? "btn--primary" : ""}`} style={{ padding: "6px 12px", fontSize: "12px" }} onClick={() => setView("timeline")}>
          时间线
        </button>
      </div>

      {view === "list" ? (
        <div className="elements-layout">
      <div className="elements-categories">
        <div style={{ padding: "8px 12px", fontSize: "11px", fontWeight: "700", color: "var(--text-muted)" }}>分类过滤器</div>
        <button type="button" className={`elements-cat-btn ${activeCat === "all" ? "active" : ""}`} onClick={() => setActiveCat("all")}>
          全部 ({all.length})
        </button>
        {ELEMENT_TYPES.map((t) => (
          <button key={t} type="button" className={`elements-cat-btn ${activeCat === t ? "active" : ""}`} onClick={() => setActiveCat(t)}>
            {ELEMENT_TYPE_ICONS[t]} {ELEMENT_TYPE_LABELS[t]} ({all.filter((e) => e.type === t).length})
          </button>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "16px", minHeight: 0 }}>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <div style={{ position: "relative", display: "flex", alignItems: "center", flex: 1 }}>
            <svg className="icon-svg" style={{ position: "absolute", left: "10px", color: "var(--text-muted)", pointerEvents: "none" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              type="text"
              className="input-text"
              placeholder="过滤要素名称 / 别名…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ padding: "8px 12px 8px 32px", fontSize: "13px" }}
            />
          </div>
          <button type="button" className="btn btn--primary" style={{ whiteSpace: "nowrap" }} onClick={handleExtract} disabled={running}>
            {running ? "抽取中…" : elements && elements.length > 0 ? "重新抽取" : "提取要素"}
          </button>
        </div>

        {error ? <div style={{ color: "var(--danger-light)", fontSize: "12px" }}>{error}</div> : null}
        {jobError ? <div style={{ color: "var(--danger-light)", fontSize: "12px" }}>{jobError}</div> : null}
        {running ? (
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <div style={{ flex: 1, height: "6px", borderRadius: "999px", background: "rgba(148, 163, 184, 0.18)", overflow: "hidden" }}>
              <div style={{ width: progressWidth, height: "100%", background: "var(--accent)", transition: "width 0.2s ease" }} />
            </div>
            <span style={{ color: "var(--text-muted)", fontSize: "12px", whiteSpace: "nowrap" }}>
              抽取中 · 批次 {done}/{total}
            </span>
            <button type="button" className="btn" style={{ padding: "4px 10px", fontSize: "12px" }} onClick={cancelExtraction} disabled={!running}>
              取消
            </button>
          </div>
        ) : job?.state === "error" ? (
          <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>{job.error ?? "任务失败"}</div>
        ) : job?.state === "cancelled" ? (
          <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>已取消</div>
        ) : null}

        <div className="elements-main">
          <table className="elements-table">
            <thead>
              <tr>
                <th>要素名称</th>
                <th>类型</th>
                <th>提及频次</th>
                <th>出处关联</th>
                <th>别名</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={item.id}>
                  <td style={{ fontWeight: "700" }}>{item.name}</td>
                  <td>
                    <span className={`entity-tag entity-tag--${item.type}`}>{ELEMENT_TYPE_LABELS[item.type]}</span>
                  </td>
                  <td style={{ fontFamily: "monospace", fontSize: "14px", fontWeight: "600" }}>{item.freq}</td>
                  <td
                    style={{ fontSize: "12px", color: "var(--accent-light)", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={item.mentions.map((m) => `${m.material_name}${m.locator.paragraph ? ` 第${m.locator.paragraph}段` : ""}：${m.snippet}`).join("\n")}
                  >
                    {mentionSources(item)}
                  </td>
                  <td style={{ color: "var(--text-dim)", fontSize: "13px" }}>{item.aliases.join("、") || "—"}</td>
                </tr>
              ))}
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: "center", color: "var(--text-muted)", padding: "40px", lineHeight: "1.7" }}>
                    {elements === null
                      ? "加载中…"
                      : all.length === 0
                        ? "尚未抽取要素。点击「提取要素」从已加工文档中抽取人物/组织/地点/事件等（需文本模型已配置）。每个要素都会绑定到素材出处。"
                        : "无匹配的要素。"}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
        </div>
      ) : view === "graph" ? (
        <ElementGraphView caseId={caseId!} />
      ) : (
        <ElementTimelineView caseId={caseId!} />
      )}
    </div>
  );
}

function ElementGraphView({ caseId }: { caseId: string }) {
  const [graph, setGraph] = useState<ElementGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);
  const [frameCite, setFrameCite] = useState<ApiCitation | null>(null);

  useEffect(() => {
    let alive = true;
    setGraph(null);
    setError(null);
    setSelectedNodeId(null);
    setSelectedEdgeKey(null);
    setFrameCite(null);
    getElementGraph(caseId)
      .then((next) => alive && setGraph(next))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [caseId]);

  if (error) return <div style={{ color: "var(--danger-light)", fontSize: "12px" }}>{error}</div>;
  if (!graph) return <div style={{ color: "var(--text-muted)", padding: "40px", textAlign: "center" }}>加载中…</div>;
  if (graph.nodes.length === 0) {
    return (
      <div style={{ color: "var(--text-muted)", padding: "40px", textAlign: "center", lineHeight: "1.7" }}>
        尚未抽取要素。请先在「要素列表」抽取要素。
      </div>
    );
  }

  const visibleNodes = graph.nodes.filter((node) => node.degree >= 1);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const positions = new Map<string, { x: number; y: number }>();
  const radius = 190;
  visibleNodes.forEach((node, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / visibleNodes.length;
    positions.set(node.id, { x: 360 + Math.cos(angle) * radius, y: 250 + Math.sin(angle) * radius });
  });
  const selectedEdge = graph.edges.find((edge) => `${edge.source}__${edge.target}` === selectedEdgeKey) ?? null;
  const selectedClaim: ApiClaim | null = selectedEdge
    ? {
        text: `${nodeById.get(selectedEdge.source)?.name ?? selectedEdge.source} × ${nodeById.get(selectedEdge.target)?.name ?? selectedEdge.target}（共现 ${selectedEdge.weight} 次）`,
        type: "fact",
        status: "verified",
        citations: selectedEdge.citations,
      }
    : null;
  const isolated = graph.nodes.filter((node) => node.degree === 0);
  const hasSelection = Boolean(selectedNodeId || selectedEdgeKey);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", minHeight: 0 }}>
      {graph.truncated ? <div style={{ color: "var(--warn-light)", fontSize: "12px" }}>为保持可读，仅展示频次最高的 40 个要素</div> : null}
      {visibleNodes.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: "13px", lineHeight: "1.7" }}>要素之间暂无共现关系（同一片段未同时出现）。下方列出全部要素。</div>
      ) : (
      <svg viewBox="0 0 720 520" style={{ width: "100%", minHeight: "360px", border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "rgba(15, 23, 42, 0.35)" }}>
        {graph.edges.map((edge) => {
          const source = positions.get(edge.source);
          const target = positions.get(edge.target);
          if (!source || !target) return null;
          const key = `${edge.source}__${edge.target}`;
          const active = selectedNodeId ? edge.source === selectedNodeId || edge.target === selectedNodeId : selectedEdgeKey === key;
          return (
            <line
              key={key}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              stroke={active ? "#facc15" : "#94a3b8"}
              strokeWidth={1 + Math.min(edge.weight, 5)}
              opacity={hasSelection ? (active ? 0.85 : 0.12) : 0.4}
              strokeLinecap="round"
              style={{ cursor: "pointer" }}
              onClick={() => {
                setSelectedEdgeKey(key);
                setSelectedNodeId(null);
              }}
            />
          );
        })}
        {visibleNodes.map((node) => {
          const pos = positions.get(node.id);
          if (!pos) return null;
          const active = selectedNodeId === node.id || graph.edges.some((edge) => selectedEdgeKey === `${edge.source}__${edge.target}` && (edge.source === node.id || edge.target === node.id));
          return (
            <g
              key={node.id}
              style={{ cursor: "pointer" }}
              opacity={hasSelection ? (active ? 1 : 0.35) : 1}
              onClick={() => {
                setSelectedNodeId(node.id);
                setSelectedEdgeKey(null);
              }}
            >
              <circle cx={pos.x} cy={pos.y} r={6 + Math.min(node.freq, 8)} fill={TYPE_COLORS[node.type]} stroke="#0f172a" strokeWidth="2" />
              <text x={pos.x + 12} y={pos.y + 4} fill="#e5e7eb" fontSize="12" fontWeight="700">
                {node.name}
              </text>
            </g>
          );
        })}
      </svg>
      )}

      {selectedClaim ? (
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "10px 12px", background: "rgba(16,24,40,0.45)", fontSize: "13px", lineHeight: "1.7" }}>
          {selectedClaim.text}
          <CitationChips claim={selectedClaim} onFrame={setFrameCite} />
        </div>
      ) : null}

      {isolated.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-muted)" }}>孤立要素（无共现）</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {isolated.map((node) => (
              <span key={node.id} className={`entity-tag entity-tag--${node.type}`}>
                {node.name}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {frameCite ? <FrameCiteView cite={frameCite} onClose={() => setFrameCite(null)} /> : null}
    </div>
  );
}

function TimelinePointRow({ point, accentBorder, onFrame }: { point: TimelinePoint; accentBorder: string; onFrame: (c: ApiCitation) => void }) {
  const claim: ApiClaim = { text: point.label, type: "fact", status: "verified", citations: point.citations };
  return (
    <div style={{ borderLeft: `2px solid ${accentBorder}`, padding: "8px 0 8px 14px", display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: 700 }}>
        <span style={{ color: TYPE_COLORS.time }}>{ELEMENT_TYPE_ICONS.time}</span>
        <span>{point.label}</span>
      </div>
      {point.related.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
          {point.related.map((item) => (
            <span key={item.id} className={`entity-tag entity-tag--${item.type}`}>
              {item.name}
            </span>
          ))}
        </div>
      ) : null}
      <div style={{ fontSize: "12px", color: "var(--text-dim)" }}>
        出处
        <CitationChips claim={claim} onFrame={onFrame} />
      </div>
    </div>
  );
}

function ElementTimelineView({ caseId }: { caseId: string }) {
  const [graph, setGraph] = useState<ElementGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameCite, setFrameCite] = useState<ApiCitation | null>(null);

  useEffect(() => {
    let alive = true;
    setGraph(null);
    setError(null);
    setFrameCite(null);
    getElementGraph(caseId)
      .then((next) => alive && setGraph(next))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [caseId]);

  if (error) return <div style={{ color: "var(--danger-light)", fontSize: "12px" }}>{error}</div>;
  if (!graph) return <div style={{ color: "var(--text-muted)", padding: "40px", textAlign: "center" }}>加载中…</div>;
  if (graph.timeline.length === 0) {
    return (
      <div style={{ background: "rgba(245, 158, 11, 0.08)", border: "1px solid rgba(245, 158, 11, 0.25)", borderRadius: "var(--radius)", padding: "16px", color: "var(--warn-light)", fontSize: "13px", lineHeight: "1.6" }}>
        无时间锚：本专题要素中未发现时间类要素。
      </div>
    );
  }

  const anchoredPoints = graph.timeline.filter((point) => point.sortKey !== null);
  const loosePoints = graph.timeline.filter((point) => point.sortKey === null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", minHeight: 0 }}>
      {!graph.anchored ? (
        <div style={{ background: "rgba(245, 158, 11, 0.08)", border: "1px solid rgba(245, 158, 11, 0.25)", borderRadius: "var(--radius)", padding: "12px", color: "var(--warn-light)", fontSize: "13px", lineHeight: "1.6" }}>
          时间信息不足，未能建立明确时序。
        </div>
      ) : null}

      {anchoredPoints.map((point) => (
        <TimelinePointRow key={point.id} point={point} accentBorder="var(--accent)" onFrame={setFrameCite} />
      ))}

      {loosePoints.length > 0 ? <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-muted)", paddingTop: anchoredPoints.length > 0 ? "8px" : 0 }}>无明确时序</div> : null}
      {loosePoints.map((point) => (
        <TimelinePointRow key={point.id} point={point} accentBorder="var(--border)" onFrame={setFrameCite} />
      ))}

      {frameCite ? <FrameCiteView cite={frameCite} onClose={() => setFrameCite(null)} /> : null}
    </div>
  );
}

// ==================== 3. Contradictions Sub-panel ====================

const CONTRADICTION_SCOPE_LABELS: Record<Contradiction["scope"], string> = {
  "cross-material": "跨文件",
  "intra-material": "文件内",
};

function citedClaim(text: string, citation: ApiCitation): ApiClaim {
  return { text, type: "fact", status: "verified", citations: [citation] };
}

export function ContradictionsPanel() {
  const { id: caseId } = useParams<{ id: string }>();
  const { user } = useSession();
  const [contradictionResult, setContradictionResult] = useState<ContradictionDetectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameCite, setFrameCite] = useState<ApiCitation | null>(null);

  const reloadContradictions = useCallback(() => {
    if (!user || !caseId) return;
    let alive = true;
    listContradictions(caseId)
      .then((result) => alive && setContradictionResult(result))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [user, caseId]);

  useEffect(() => {
    return reloadContradictions();
  }, [reloadContradictions]);

  const onContradictionsDone = useCallback(() => {
    void reloadContradictions();
  }, [reloadContradictions]);
  const { job, error: jobError, start: startDetection, cancel: cancelDetection } = useExtractionJob(caseId ?? "", "contradictions", onContradictionsDone);

  const handleDetect = () => {
    if (!user || !caseId) return;
    setError(null);
    startDetection();
  };

  const jobResult = job?.kind === "contradictions" && job.result ? job.result as ContradictionDetectionResult : null;
  const latestResult = jobResult ?? contradictionResult;
  const all = latestResult?.contradictions ?? [];
  const running = job?.state === "running";
  const total = job?.progress.total ?? 0;
  const done = job?.progress.done ?? 0;
  const progressWidth = running && total > 0 ? `${Math.min(100, Math.round((done / total) * 100))}%` : "38%";
  const statusLabel = latestResult?.status === "failed" ? "失败" : latestResult?.status === "degraded" ? "降级完成" : latestResult ? "完成" : "未检测";

  return (
    <div className="contradictions-layout">
      <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
        <span style={{ flex: 1, fontSize: "12px", color: "var(--text-dim)" }}>
          已发现 <strong style={{ color: "#fff" }}>{all.length}</strong> 组矛盾线索
        </span>
        <button type="button" className="btn btn--primary" style={{ whiteSpace: "nowrap" }} onClick={handleDetect} disabled={running}>
          {running ? "检测中…" : latestResult && latestResult.contradictions.length > 0 ? "重新检测" : "检测矛盾"}
        </button>
      </div>

      {latestResult ? (
        <div style={{ color: "var(--text-muted)", fontSize: "12px", lineHeight: "1.7" }}>
          覆盖 {latestResult.processedChunks}/{latestResult.totalChunks} 个素材块 · 状态：{statusLabel}
          {latestResult.truncated ? " · 覆盖不完整" : ""}
          {latestResult.warnings.length > 0 ? ` · ${latestResult.warnings.join("；")}` : ""}
        </div>
      ) : null}
      {latestResult?.status === "failed" ? (
        <div style={{ color: "var(--danger-light)", fontSize: "12px" }}>{latestResult.error ?? "矛盾检测失败"}</div>
      ) : null}
      {error ? <div style={{ color: "var(--danger-light)", fontSize: "12px" }}>{error}</div> : null}
      {jobError ? <div style={{ color: "var(--danger-light)", fontSize: "12px" }}>{jobError}</div> : null}
      {running ? (
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <div style={{ flex: 1, height: "6px", borderRadius: "999px", background: "rgba(148, 163, 184, 0.18)", overflow: "hidden" }}>
            <div style={{ width: progressWidth, height: "100%", background: "var(--accent)", transition: "width 0.2s ease" }} />
          </div>
          <span style={{ color: "var(--text-muted)", fontSize: "12px", whiteSpace: "nowrap" }}>
            检测中 · 批次 {done}/{total}
          </span>
          <button type="button" className="btn" style={{ padding: "4px 10px", fontSize: "12px" }} onClick={cancelDetection} disabled={!running}>
            取消
          </button>
        </div>
      ) : job?.state === "error" ? (
        <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>{job.error ?? "任务失败"}</div>
      ) : job?.state === "cancelled" ? (
        <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>已取消</div>
      ) : null}

      <div className="contradictions-list">
        {latestResult === null ? (
          <div style={{ color: "var(--text-muted)", padding: "40px", textAlign: "center" }}>加载中…</div>
        ) : latestResult.status === "failed" ? (
          <div style={{ color: "var(--text-muted)", padding: "40px", textAlign: "center", lineHeight: "1.7" }}>
            矛盾检测失败，未产出可复核结果。
          </div>
        ) : all.length === 0 ? (
          <div style={{ color: "var(--text-muted)", padding: "40px", textAlign: "center", lineHeight: "1.7" }}>
            检测完成，未发现矛盾线索。
          </div>
        ) : (
          all.map((item) => (
            <div key={item.id} className="contradiction-row">
              <div className="contradiction-row__head">
                <div style={{ fontWeight: 700 }}>{item.attribute ? `${item.entity} · ${item.attribute}` : item.entity}</div>
                <div style={{ display: "inline-flex", gap: "8px", alignItems: "center", flexShrink: 0 }}>
                  <span className={`contradiction-scope contradiction-scope--${item.scope === "cross-material" ? "cross" : "intra"}`}>
                    {CONTRADICTION_SCOPE_LABELS[item.scope]}
                  </span>
                  <span className="contradiction-confidence">{Math.round(item.confidence * 100)}%</span>
                </div>
              </div>

              <div className="contradiction-claims">
                <div className="contradiction-claim">
                  <div className="contradiction-claim__label">陈述 A</div>
                  <div>
                    {item.claim_a.text}
                    <CitationChips claim={citedClaim(item.claim_a.text, item.claim_a.citation)} onFrame={setFrameCite} />
                  </div>
                </div>
                <div className="contradiction-claim">
                  <div className="contradiction-claim__label">陈述 B</div>
                  <div>
                    {item.claim_b.text}
                    <CitationChips claim={citedClaim(item.claim_b.text, item.claim_b.citation)} onFrame={setFrameCite} />
                  </div>
                </div>
              </div>

              <div style={{ fontSize: "12px", color: "var(--text-dim)", lineHeight: "1.7" }}>{item.rationale}</div>
            </div>
          ))
        )}
      </div>

      {frameCite ? <FrameCiteView cite={frameCite} onClose={() => setFrameCite(null)} /> : null}
    </div>
  );
}

// ==================== 4. Inquiry Sub-panel ====================

function CitationChips({ claim, onFrame }: { claim: ApiClaim; onFrame: (c: ApiCitation) => void }) {
  if (claim.citations.length === 0) return null;
  return (
    <span style={{ marginLeft: "6px" }}>
      {claim.citations.map((c, i) => {
        // 音频引用带时间码 → 点击回听片段；视频/图像带 bbox/时间码 → 点击取帧框选（硬验收，§4.3/§6）。
        const audioTc = c.modality === "audio" ? c.locator.timecode : undefined;
        const framed = (c.modality === "video" || c.modality === "image") && Boolean(c.locator.bbox || c.locator.timecode);
        const quote = c.quote ?? c.snippet;
        const supportStatus = c.support_status ?? c.support_label;
        const support = supportStatus ? ` · 支持性：${supportStatus}` : "";
        const loc = c.locator.timecode
          ? ` · 时间：${c.locator.timecode}秒${c.locator.speaker ? ` · 说话人：${c.locator.speaker}` : ""}`
          : c.locator.paragraph
            ? ` · 第${c.locator.paragraph}段`
            : "";
        const onClick = audioTc ? () => void playCitedSegment(c.material_id, audioTc) : framed ? () => onFrame(c) : undefined;
        const hint = audioTc ? "\n（点击回听被引用片段）" : framed ? "\n（点击查看引用帧并框选）" : "";
        return (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: "4px", maxWidth: "360px", verticalAlign: "middle" }}>
            <span
              className="citation"
              style={onClick ? { cursor: "pointer" } : undefined}
              title={`${c.material_name}${loc}\n${quote}${support}${hint}`}
              onClick={onClick}
            >
              {audioTc ? (
                <svg className="icon-svg" style={{ width: "8px", height: "8px", marginRight: "3px", fill: "currentColor", verticalAlign: "middle" }} viewBox="0 0 24 24" stroke="none">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
              ) : framed ? (
                <svg className="icon-svg" style={{ width: "8px", height: "8px", marginRight: "3px", verticalAlign: "middle" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                </svg>
              ) : null}
              {i + 1}
            </span>
            {supportStatus ? <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>{supportStatus}</span> : null}
            {c.quote ? <span title={c.quote} style={{ fontSize: "11px", color: "var(--text-dim)", maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>“{c.quote}”</span> : null}
          </span>
        );
      })}
    </span>
  );
}

function InquiryAnswer({ inquiry, onFrame, reviewedRefs, onReview }: { inquiry: ApiInquiry; onFrame: (c: ApiCitation) => void; reviewedRefs: Set<string>; onReview: (ref: string) => void }) {
  if (inquiry.status !== "answered") {
    const unverified = inquiry.claims.filter((c) => c.status === "unverified");
    return (
      <div style={{ color: "var(--warn-light)", fontSize: "13px", lineHeight: "1.6", display: "inline-flex", alignItems: "flex-start", gap: "6px" }}>
        <svg className="icon-svg" style={{ color: "var(--warn-light)", marginTop: "3px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <div>
          {inquiry.answer}
          {unverified.length > 0 ? (
            <div style={{ marginTop: "8px", color: "var(--text-dim)" }}>
              （以下为无有效出处的待核提示，不作为事实）
              {unverified.map((c, i) => {
                const ref = `${inquiry.id}:${inquiry.claims.indexOf(c)}`;
                return (
                  <div key={i} style={{ marginTop: "4px" }}>
                    · {c.text}
                    {c.support_status ? <span style={{ color: "var(--text-muted)", fontSize: "11px", marginLeft: "6px" }}>{c.support_status}</span> : null}
                    {reviewedRefs.has(ref)
                      ? <span style={{ color: "#4caf50", fontSize: "11px", marginLeft: "6px" }}>✓ 已校对</span>
                      : <button type="button" className="btn btn--ghost" style={{ padding: "1px 8px", fontSize: "11px", marginLeft: "6px" }} onClick={() => onReview(ref)}>点此校对</button>
                    }
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  const verified = inquiry.claims.filter((c) => c.status === "verified" || c.support_status === "support-unverified");
  return (
    <div style={{ fontSize: "13px", lineHeight: "1.7" }}>
      {verified.map((c, i) => {
        const ref = `${inquiry.id}:${inquiry.claims.indexOf(c)}`;
        return (
          <div key={i} style={{ marginBottom: "6px" }}>
            {i + 1}. {c.text}
            {c.support_status === "support-unverified" ? (
              <span style={{ marginLeft: "6px", fontSize: "11px", color: "var(--text-muted)" }}>support-unverified</span>
            ) : null}
            {c.type === "inference" ? (
              <>
                <span style={{ marginLeft: "6px", fontSize: "11px", color: "var(--text-muted)" }}>（推断）</span>
                {reviewedRefs.has(ref)
                  ? <span style={{ color: "#4caf50", fontSize: "11px", marginLeft: "6px" }}>✓ 已校对</span>
                  : <button type="button" className="btn btn--ghost" style={{ padding: "1px 8px", fontSize: "11px", marginLeft: "6px" }} onClick={() => onReview(ref)}>点此校对</button>
                }
              </>
            ) : null}
            <CitationChips claim={c} onFrame={onFrame} />
          </div>
        );
      })}
    </div>
  );
}

interface ToolTraceEntry {
  key: string;
  name: string;
  status: "running" | "ok" | "failed";
}

export function InquiryPanel() {
  const { id: caseId } = useParams<{ id: string }>();
  const { user } = useSession();
  const [history, setHistory] = useState<ApiInquiry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deepMode, setDeepMode] = useState(false);
  const [activeDeep, setActiveDeep] = useState(false);
  const [frameCite, setFrameCite] = useState<ApiCitation | null>(null);
  const [reviewedRefs, setReviewedRefs] = useState<Set<string>>(new Set());
  const [liveQuestion, setLiveQuestion] = useState<string | null>(null);
  const [liveText, setLiveText] = useState("");
  const [toolTrace, setToolTrace] = useState<ToolTraceEntry[]>([]);
  const streamControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const userStoppedRef = useRef(false);
  const toolOrderRef = useRef(0);

  useEffect(() => {
    if (!user || !caseId) return;
    let alive = true;
    setReviewedRefs(new Set());
    listInquiries(caseId)
      .then((list) => alive && setHistory(list))
      .catch((e: Error) => alive && setError(e.message));
    void (async () => {
      try {
        const events = await listCaseAudit(caseId);
        if (!alive) return;
        const refs = new Set(
          events
            .filter((e) => e.action === "review.mark" && typeof e.detail?.ref === "string")
            .map((e) => e.detail!.ref as string),
        );
        setReviewedRefs(refs);
      } catch { /* best-effort; leave empty */ }
    })();
    return () => {
      alive = false;
    };
  }, [user, caseId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      userStoppedRef.current = true;
      streamControllerRef.current?.abort();
    };
  }, []);

  const clearLiveState = () => {
    setLiveQuestion(null);
    setLiveText("");
    setToolTrace([]);
  };

  const handleStreamEvent = (event: ApiInquiryStreamEvent) => {
    if (!mountedRef.current || userStoppedRef.current) return;
    if (event.type === "token") {
      setLiveText((prev) => prev + event.text);
      return;
    }
    if (event.type === "tool_start") {
      const key = `${event.name}:${toolOrderRef.current}`;
      toolOrderRef.current += 1;
      setToolTrace((prev) => [...prev, { key, name: event.name, status: "running" }]);
      return;
    }
    if (event.type === "tool_result") {
      setToolTrace((prev) => {
        const runningIndex = prev.findIndex((entry) => entry.name === event.name && entry.status === "running");
        const status = event.ok ? "ok" : "failed";
        if (runningIndex === -1) {
          const key = `${event.name}:${toolOrderRef.current}`;
          toolOrderRef.current += 1;
          return [...prev, { key, name: event.name, status }];
        }
        return prev.map((entry, index) => (index === runningIndex ? { ...entry, status } : entry));
      });
      return;
    }
    if (event.type === "done") {
      setHistory((prev) => [...prev, event.inquiry]);
      clearLiveState();
      return;
    }
    if (event.type === "error") {
      setError(event.message);
      clearLiveState();
    }
  };

  const handleStop = () => {
    userStoppedRef.current = true;
    streamControllerRef.current?.abort();
    clearLiveState();
    setBusy(false);
  };

  const markReviewed = async (ref: string) => {
    if (!caseId) return;
    try {
      await markReview(caseId, ref);
      setReviewedRefs((prev) => new Set(prev).add(ref));
    } catch { /* 忽略：保持未校对态 */ }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = input.trim();
    if (!q || !user || !caseId || busy) return;
    userStoppedRef.current = false;
    toolOrderRef.current = 0;
    setBusy(true);
    setError(null);
    setInput("");
    setLiveQuestion(q);
    setLiveText("");
    setToolTrace([]);
    if (deepMode) {
      setActiveDeep(true);
      try {
        const inquiry = await askInquiryDeep(caseId, q);
        if (!mountedRef.current) return;
        setHistory((prev) => [...prev, inquiry]);
        clearLiveState();
      } catch (err) {
        if (mountedRef.current) {
          setError((err as Error).message);
          clearLiveState();
        }
      } finally {
        if (mountedRef.current) {
          setActiveDeep(false);
          setBusy(false);
        }
      }
      return;
    }
    const controller = new AbortController();
    streamControllerRef.current = controller;
    try {
      await askInquiryStream(caseId, q, handleStreamEvent, controller.signal);
    } catch (err) {
      if (!userStoppedRef.current && mountedRef.current) {
        setError((err as Error).message);
        clearLiveState();
      }
    } finally {
      if (mountedRef.current) {
        if (streamControllerRef.current === controller) streamControllerRef.current = null;
        setBusy(false);
      }
    }
  };

  return (
    <div className="inquiry-layout">
      <div className="chat-messages">
        {history.length === 0 && !busy && !liveQuestion ? (
          <div style={{ color: "var(--text-dim)", fontSize: "13px", lineHeight: "1.7", padding: "8px" }}>
            向 AI 提问本专题已加工素材中的关联线索。每条结论都会绑定到素材出处；无支撑时系统回「现有材料不足以判断」，不臆造。
          </div>
        ) : null}
        {history.map((inq) => (
          <div key={inq.id}>
            <div className="chat-bubble chat-bubble--user">
              <div className="chat-avatar">
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                </svg>
              </div>
              <div className="chat-content">
                <p>{inq.question}</p>
              </div>
            </div>
            <div className="chat-bubble chat-bubble--ai">
              <div className="chat-avatar">
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4M8 15h.01M16 15h.01"/>
                </svg>
              </div>
              <div className="chat-content">
                <InquiryAnswer inquiry={inq} onFrame={setFrameCite} reviewedRefs={reviewedRefs} onReview={markReviewed} />
              </div>
            </div>
          </div>
        ))}
        {liveQuestion ? (
          <>
            <div className="chat-bubble chat-bubble--user">
              <div className="chat-avatar">
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                </svg>
              </div>
              <div className="chat-content">
                <p>{liveQuestion}</p>
              </div>
            </div>
            <div className="chat-bubble chat-bubble--ai chat-bubble--live">
              <div className="chat-avatar">
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4M8 15h.01M16 15h.01"/>
                </svg>
              </div>
              <div className="chat-content">
                <p className="live-narration">{liveText || (activeDeep ? "深度分析中…（已提高检索/读取预算，可能稍慢）" : "研判中…")}</p>
                {toolTrace.length > 0 ? (
                  <div className="tool-trace" aria-label="工具调用轨迹">
                    {toolTrace.map((entry) => (
                      <div key={entry.key} className={`tool-trace__item tool-trace__item--${entry.status}`}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                          <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                          </svg>
                          调用 {entry.name}…
                        </span>
                        <span>
                          {entry.status === "running" ? (
                            "进行中"
                          ) : entry.status === "ok" ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                              <svg className="icon-svg" style={{ color: "var(--ok-light)", width: "12px", height: "12px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12"/>
                              </svg>
                              成功
                            </span>
                          ) : (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                              <svg className="icon-svg" style={{ color: "var(--danger-light)", width: "12px", height: "12px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                              </svg>
                              失败
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
        {busy && !liveQuestion ? (
          <div className="chat-bubble chat-bubble--ai chat-bubble--live">
            <div className="chat-avatar">
              <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4M8 15h.01M16 15h.01"/>
              </svg>
            </div>
            <div className="chat-content">
              <p className="live-narration">{activeDeep ? "深度分析中…（已提高检索/读取预算，可能稍慢）" : "研判中…"}</p>
            </div>
          </div>
        ) : null}
        {error ? <div style={{ color: "var(--danger-light)", fontSize: "12px", padding: "8px" }}>{error}</div> : null}
        {frameCite ? (
          <div style={{ padding: "8px" }}>
            <FrameCiteView cite={frameCite} onClose={() => setFrameCite(null)} />
          </div>
        ) : null}
      </div>

      <form onSubmit={handleSend} className="chat-input-area">
        <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", color: "var(--text-muted)", fontSize: "12px", whiteSpace: "nowrap" }}>
          <input
            type="checkbox"
            checked={deepMode}
            onChange={(e) => setDeepMode(e.target.checked)}
            disabled={busy}
          />
          深度分析
        </label>
        <input
          type="text"
          className="input-text"
          placeholder="向 AI 助手提问有关本专题的关联线索…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="btn btn--primary" disabled={busy}>
          发送
        </button>
        {busy && !activeDeep ? (
          <button type="button" className="btn btn--danger" onClick={handleStop}>
            停止
          </button>
        ) : null}
      </form>
    </div>
  );
}

// ==================== 5. Report Sub-panel ====================

const REPORT_STEPS: { status: ApiReport["status"]; label: string; hint: string }[] = [
  { status: "draft", label: "草稿起草", hint: "编辑标题与正文，保存即落盘并渲染公文" },
  { status: "in_review", label: "待保密员复核", hint: "提交后由保密员/管理员核对密级与完整性" },
  { status: "approved", label: "已复核", hint: "复核通过，方可导出" },
  { status: "exported", label: "已导出", hint: "导出留存（动作入审计）" },
];

function specToBody(report: ApiReport | null): string {
  if (!report) return "";
  return report.spec.sections.map((s) => (s.heading ? `${s.heading}\n${s.body}` : s.body)).join("\n\n");
}

export function ReportPanel() {
  const { id: caseId } = useParams<{ id: string }>();
  const { user } = useSession();
  const canReview = user?.role === "security" || user?.role === "admin";

  const [report, setReport] = useState<ApiReport | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!user || !caseId) return;
    let alive = true;
    getReport(caseId)
      .then((r) => {
        if (!alive) return;
        setReport(r);
        if (r) {
          setTitle(r.spec.title);
          setBody(specToBody(r));
        }
        setLoaded(true);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [user, caseId]);

  const run = async (fn: () => Promise<ApiReport>) => {
    if (!user || !caseId || busy) return;
    setBusy(true);
    setError(null);
    try {
      setReport(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveDraft = () => {
    if (!title.trim()) {
      setError("报告标题为必填项");
      return;
    }
    void run(() => draftReport(caseId!, { title: title.trim(), body }));
  };

  const handleExport = async () => {
    if (!user || !caseId) return;
    setBusy(true);
    setError(null);
    try {
      const out = await exportReport(caseId);
      const blob = new Blob([out.content], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = out.filename;
      a.click();
      URL.revokeObjectURL(url);
      setReport((prev) => (prev ? { ...prev, status: out.status } : prev));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const status = report?.status ?? "draft";
  const stepIndex = REPORT_STEPS.findIndex((s) => s.status === status);

  return (
    <div className="report-layout">
      <div className="report-editor">
        <div className="report-toolbar">
          <span style={{ fontSize: "12px", color: "var(--text-dim)" }}>
            状态：<strong style={{ color: "var(--accent-light)" }}>{REPORT_STEPS[stepIndex]?.label ?? "草稿起草"}</strong>
            {report?.spec.classification ? ` · 密级 ${report.spec.classification}` : ""}
            {report && !report.rendered ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", marginLeft: "8px", color: "var(--danger-light)" }}>
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                公文渲染未完成（缺 python3?）
              </span>
            ) : ""}
          </span>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn--primary" style={{ padding: "4px 12px", fontSize: "12px" }} onClick={handleSaveDraft} disabled={busy}>
            {busy ? "处理中…" : report ? "保存修改（回草稿）" : "生成草稿"}
          </button>
        </div>

        <input type="text" className="report-title-input" placeholder="报告标题，例如：关于某网络入侵事件的情况通报" value={title} onChange={(e) => setTitle(e.target.value)} />

        <textarea
          className="report-textarea"
          placeholder="正文：可分多段填写基本情况、分析研判、处置建议……保存后由 intel-bulletin 渲染为公文格式。"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {error ? <div style={{ color: "var(--danger-light)", fontSize: "12px", padding: "8px 0" }}>{error}</div> : null}
      </div>

      <div className="report-sidebar">
        <div className="report-sidebar__title">报告复核状态</div>

        <div className="workflow-steps">
          {REPORT_STEPS.map((step, i) => (
            <div key={step.status} className={`workflow-step ${i === stepIndex ? "workflow-step--active" : i < stepIndex ? "workflow-step--done" : ""}`}>
              <span className="workflow-dot">
                {i < stepIndex ? (
                  <svg className="icon-svg" style={{ width: "8px", height: "8px", verticalAlign: "middle" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                ) : ""}
              </span>
              <div>
                <div style={{ fontWeight: i === stepIndex ? "700" : "600" }}>{step.label}</div>
                <span style={{ fontSize: "11px", opacity: 0.7 }}>{step.hint}</span>
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: "auto", borderTop: "1px solid var(--border)", paddingTop: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
          {!loaded ? (
            <span style={{ fontSize: "12px", color: "var(--text-dim)" }}>加载报告状态…</span>
          ) : (
            <>
              <button type="button" className="btn btn--primary" style={{ width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px" }} disabled={busy || !report || status !== "draft"} onClick={() => run(() => submitReport(caseId!))}>
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
                提交保密员复核
              </button>
              {canReview ? (
                <button type="button" className="btn" style={{ width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px" }} disabled={busy || status !== "in_review"} onClick={() => run(() => approveReport(caseId!))}>
                  <svg className="icon-svg" style={{ color: "var(--ok-light)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                  复核核准
                </button>
              ) : null}
              <button
                type="button"
                className={status === "approved" || status === "exported" ? "btn btn--primary" : "btn btn--danger"}
                style={{ width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                disabled={busy || (status !== "approved" && status !== "exported")}
                title={status === "approved" || status === "exported" ? "导出公文 .md" : "必须完成保密复核后方可导出（闸门）"}
                onClick={handleExport}
              >
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                {status === "approved" || status === "exported" ? "导出报告 (.md)" : "导出报告 (未授权)"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ==================== 6. CaseAuditPanel Sub-panel ====================

/** 审计动作码 → 中文研判动作（未知码原样显示）。 */
const AUDIT_ACTION_LABELS: Record<string, string> = {
  "case.create": "创建专题",
  "case.update": "更新专题",
  "material.ingest": "汇入素材",
  "material.process": "加工媒体素材",
  "material.index": "建立检索索引",
  "material.reindex": "重建检索索引",
  "material.delete": "删除素材",
  "inquiry.create": "智能问答",
  "inquiry.retrieve": "检索取材",
  "element.extract": "提取要素",
  "task.run.create": "创建任务",
  "task.stage.advance": "推进任务阶段",
  "task.stage.confirm": "确认任务检查点",
  "report.draft": "起草通报",
  "report.submit": "提交复核",
  "report.approve": "复核核准",
  "report.export": "导出通报",
  "audit.export": "导出审计",
};

const AUDIT_RESULT: Record<AuditEvent["result"], { text: string; color: string }> = {
  ok: { text: "成功", color: "var(--ok-light)" },
  deny: { text: "拒绝", color: "var(--warn-light)" },
  error: { text: "失败", color: "var(--danger-light)" },
};

function auditActionLabel(e: AuditEvent): string {
  return AUDIT_ACTION_LABELS[e.action] ?? e.action;
}

export function CaseAuditPanel() {
  const { id: caseId } = useParams<{ id: string }>();
  const { user } = useSession();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
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
  const rows = events ? [...events].reverse() : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ background: "rgba(16,24,40,0.3)", border: "1px solid var(--border)", padding: "16px 20px", borderRadius: "var(--radius)" }}>
        <h4 style={{ fontSize: "14px", fontWeight: "700", marginBottom: "4px", display: "inline-flex", alignItems: "center", gap: "6px" }}>
          <svg className="icon-svg" style={{ width: "14px", height: "14px", color: "var(--accent-light)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
          本地审计链完整性校验（Integrity Chain）
        </h4>
        <p style={{ fontSize: "12px", color: "var(--text-dim)", lineHeight: "1.6" }}>
          本专题所有变更经 append-only 哈希连环锁记录（镜像自全局审计链）。共 <strong style={{ color: "#fff" }}>{events?.length ?? "…"}</strong> 条事件
          {last ? (
            <>
              ；末位指纹 <code style={{ color: "var(--warn-light)", fontFamily: "monospace" }}>{last.event_hash.slice(0, 12)}…{last.event_hash.slice(-6)}</code>
            </>
          ) : null}
          。局部修改、删除或插入会被 verify 检出（审计中心可一键校验）；非密码学防篡改（无外部签名/锚定）。
        </p>
      </div>

      {error ? <div style={{ color: "var(--danger-light)", fontSize: "12px" }}>{error}</div> : null}

      <div className="audit-layout">
        <table className="audit-table">
          <thead>
            <tr>
              <th>时间戳</th>
              <th>操作账户</th>
              <th>研判动作</th>
              <th>对象</th>
              <th>执行状态</th>
              <th>防篡改指纹 (HASH)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const r = AUDIT_RESULT[e.result];
              return (
                <tr key={e.id}>
                  <td style={{ fontFamily: "monospace" }}>{e.ts.replace("T", " ").slice(0, 19)}</td>
                  <td style={{ fontWeight: "600" }}>{e.user}</td>
                  <td>{auditActionLabel(e)}</td>
                  <td style={{ fontFamily: "monospace", fontSize: "12px", color: "var(--text-dim)" }}>{e.object}</td>
                  <td style={{ color: r.color }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <span className="status-dot" style={{ backgroundColor: "currentColor" }} />
                      <span>{r.text}</span>
                    </span>
                  </td>
                  <td className="audit-hash">{e.event_hash.slice(0, 10)}…{e.event_hash.slice(-6)}</td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", color: "var(--text-muted)", padding: "32px" }}>
                  {events === null ? "加载审计记录…" : "本专题暂无审计事件。"}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
