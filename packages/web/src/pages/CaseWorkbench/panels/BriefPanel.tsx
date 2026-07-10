import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  cancelJob,
  getBrief,
  refreshBrief,
  updateCase,
  type ApiAutoInquiryItemStatus,
  type ApiAutoInquiryProgress,
  type ApiBrief,
  type ApiBriefContradiction,
  type ApiBriefOverviewSentence,
  type ApiCitation,
  type ApiClaim,
} from "../../../api";
import { useSession } from "../../../state/session";
import { useWorkbenchContext } from "../../CaseWorkbench";
import { CitationChips } from "../components/CitationChips";
import { CoverageMeter } from "../components/CoverageMeter";
import { FrameCiteView } from "../components/FrameCiteView";
import { TaskOverview } from "../components/TaskOverview";
import { useExtractionJob } from "../hooks/useExtractionJob";
import {
  CONTRADICTION_SCOPE_LABELS,
  ELEMENT_TYPE_LABELS,
  scrollWorkbenchBodyIntoView,
} from "../components/helpers";

/**
 * 研判简报（阶段三 M2 / 计划 D1）：进入专题的落地视图。头部并入任务阶段条（复用
 * TaskOverview）+ autopilot 开关 + 刷新；六个板块（概览 / 时间线 / 关键实体 / 未处置矛盾 /
 * 待核问题 / 报告覆盖度）各自深链到对应 Tab。概览段由服务端 LLM 生成并逐句绑定引用，
 * 引用可点回素材原文；模型不可用时降级为纯统计简报，页面明示。
 */

/** 概览句 / 矛盾陈述复用 CitationChips：把单条引用包成最小 claim 交给现有溯源芯片。 */
function citationClaim(text: string, citation: ApiCitation): ApiClaim {
  return { text, type: "fact", status: "verified", citations: [citation] };
}

function BriefSection({
  title,
  count,
  caseId,
  tab,
  tabLabel,
  children,
}: {
  title: string;
  count?: number;
  caseId: string;
  tab?: string;
  tabLabel?: string;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <section className="brief-section">
      <div className="brief-section__head">
        <h3 className="brief-section__title">
          {title}
          {typeof count === "number" ? <span className="brief-section__count">{count}</span> : null}
        </h3>
        {tab ? (
          <button
            type="button"
            className="brief-section__link"
            onClick={() => {
              navigate(`/cases/${encodeURIComponent(caseId)}/${tab}`);
              scrollWorkbenchBodyIntoView();
            }}
          >
            {tabLabel ?? "查看全部"} →
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function OverviewBlock({ brief, onFrame, caseId }: { brief: ApiBrief; onFrame: (c: ApiCitation) => void; caseId: string }) {
  return (
    <BriefSection title="案情概览" caseId={caseId} tab="materials" tabLabel="回到素材">
      <div className="brief-overview__caveat">AI 依据原文生成，仅供研判参考，需人工复核；下方每句均可点引用回原文核对。</div>
      {brief.degraded ? (
        <div className="brief-empty">AI 概览暂不可用（文本模型未配置或本次生成失败），当前为纯统计简报。各板块统计与线索仍如实展示。</div>
      ) : brief.overview.length === 0 ? (
        <div className="brief-empty">本次未生成可回溯的概览句（素材过少或未能逐句绑定原文）。</div>
      ) : (
        <ol className="brief-overview__list">
          {brief.overview.map((s: ApiBriefOverviewSentence, i) => (
            <li key={i} className="brief-overview__item">
              <span className="brief-overview__text">{s.text}</span>
              <CitationChips claim={citationClaim(s.text, s.citation)} onFrame={onFrame} />
            </li>
          ))}
        </ol>
      )}
    </BriefSection>
  );
}

function ContradictionCard({ c, onFrame }: { c: ApiBriefContradiction; onFrame: (c: ApiCitation) => void }) {
  return (
    <div className="brief-contradiction">
      <div className="brief-contradiction__head">
        <strong>
          {c.entity}
          {c.attribute ? ` · ${c.attribute}` : ""}
        </strong>
        <span className="brief-contradiction__meta">
          {CONTRADICTION_SCOPE_LABELS[c.scope]} · 置信 {Math.round(c.confidence * 100)}%
        </span>
      </div>
      <div className="brief-contradiction__claim">
        <span className="brief-contradiction__tag">说法 A</span>
        <span>{c.claim_a.text}</span>
        <CitationChips claim={citationClaim(c.claim_a.text, c.claim_a.citation)} onFrame={onFrame} />
      </div>
      <div className="brief-contradiction__claim">
        <span className="brief-contradiction__tag">说法 B</span>
        <span>{c.claim_b.text}</span>
        <CitationChips claim={citationClaim(c.claim_b.text, c.claim_b.citation)} onFrame={onFrame} />
      </div>
      {c.rationale ? <div className="brief-contradiction__rationale">{c.rationale}</div> : null}
    </div>
  );
}

const AUTO_INQUIRY_STATUS_LABEL: Record<ApiAutoInquiryItemStatus, string> = {
  pending: "待跑",
  running: "进行中",
  candidate: "已产生候选",
  done: "已完成",
  failed: "失败",
};

/**
 * 自动研判批处理进度（阶段三 M3）：整体进度 + 逐题状态徽章；运行中提供取消按钮；
 * 已产生候选的问题深链到「结论核验」Tab（候选结论在那里入池复核）。数据源为简报轮询
 * 携带的 autoInquiry（durable，读 auto-inquiry.json），跨服务重启仍可见。
 */
function AutoInquiryProgressBlock({
  progress,
  canManage,
  cancelling,
  restarting,
  onCancel,
  onRestart,
  onOpenFindings,
}: {
  progress: ApiAutoInquiryProgress;
  canManage: boolean;
  cancelling: boolean;
  restarting: boolean;
  onCancel: () => void;
  onRestart: () => void;
  onOpenFindings: () => void;
}) {
  const statusLabel = progress.status === "running"
    ? "研判进行中"
    : progress.status === "cancelled"
      ? "已取消"
      : progress.status === "failed"
        ? "运行失败"
        : "研判完成";
  const canRestart = progress.status === "cancelled" || progress.status === "failed" || progress.items.some((item) => item.status === "failed");
  return (
    <div className="auto-inquiry">
      <div className="auto-inquiry__head">
        <span className="auto-inquiry__title">自动研判</span>
        <span className="auto-inquiry__status">
          {statusLabel} · {progress.completed}/{progress.total}
        </span>
        <span className="auto-inquiry__spacer" />
        {canManage && progress.status === "running" ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel} disabled={cancelling}>
            {cancelling ? "取消中…" : "取消"}
          </button>
        ) : canManage && canRestart ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onRestart} disabled={restarting}>
            {restarting ? "重启中…" : "重新运行"}
          </button>
        ) : null}
      </div>
      <div className="auto-inquiry__bar" aria-hidden="true">
        {progress.items.map((item, i) => (
          <span key={i} className={`auto-inquiry__seg auto-inquiry__seg--${item.status}`} />
        ))}
      </div>
      <div className="auto-inquiry__items">
        {progress.items.map((item, i) => {
          const badge = (
            <span className={`auto-inquiry__badge auto-inquiry__badge--${item.status}`}>{AUTO_INQUIRY_STATUS_LABEL[item.status]}</span>
          );
          return item.status === "candidate" ? (
            <button
              key={i}
              type="button"
              className="auto-inquiry__item"
              title="已产生候选结论，点击去结论核验复核入池"
              onClick={onOpenFindings}
            >
              <span className="auto-inquiry__item-text">{item.question}</span>
              {badge}
            </button>
          ) : (
            <div key={i} className="auto-inquiry__item" title={item.error ?? undefined}>
              <span className="auto-inquiry__item-text">{item.question}</span>
              {badge}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function BriefPanel() {
  const { id: caseId } = useParams<{ id: string }>();
  const { user } = useSession();
  const { canManage } = useWorkbenchContext();
  const navigate = useNavigate();
  const [brief, setBrief] = useState<ApiBrief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [autopilotBusy, setAutopilotBusy] = useState(false);
  const [cancellingBatch, setCancellingBatch] = useState(false);
  const [restartingBatch, setRestartingBatch] = useState(false);
  const [frameCite, setFrameCite] = useState<ApiCitation | null>(null);
  const briefRequestRef = useRef<{ caseId: string; promise: Promise<ApiBrief> } | null>(null);

  /**
   * 简报包含真模型概览，不允许轮询、StrictMode 或手动刷新叠加发起同一请求。
   * 强制刷新会等当前请求收尾，从而保持服务端生成单飞。
   */
  const loadBrief = useCallback((force = false, signal?: AbortSignal): Promise<ApiBrief> => {
    if (!caseId) return Promise.reject(new Error("缺少专题 ID"));
    const current = briefRequestRef.current;
    if (current?.caseId === caseId && !force) return current.promise;

    const promise = (async () => {
      if (current?.caseId === caseId && force) await current.promise.catch(() => undefined);
      return force ? refreshBrief(caseId, signal) : getBrief(caseId, false, signal);
    })();
    briefRequestRef.current = { caseId, promise };
    void promise.finally(() => {
      if (briefRequestRef.current?.promise === promise) briefRequestRef.current = null;
    }).catch(() => undefined);
    return promise;
  }, [caseId]);

  const syncBrief = useCallback(() => {
    void loadBrief().then((next) => {
      setBrief(next);
      setError(null);
    }).catch((e: Error) => {
      if (e.name !== "AbortError") setError(e.message);
    });
  }, [loadBrief]);

  const autoInquiryJob = useExtractionJob(caseId ?? "", "auto-inquiry", syncBrief);

  useEffect(() => {
    if (!user || !caseId) return;
    let alive = true;
    let timer: number | null = null;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const next = await loadBrief(false, controller.signal);
        if (!alive) return;
        setBrief(next);
        setError(null);
      } catch (e) {
        if (alive && (e as Error).name !== "AbortError") setError((e as Error).message);
      } finally {
        // 上一次完成后再计时，避免慢模型请求与下一轮重叠。
        if (alive) timer = window.setTimeout(() => void poll(), 8000);
      }
    };
    // 延后到下一个 task，React StrictMode 的探测性 effect 会在发请前被清理。
    timer = window.setTimeout(() => void poll(), 0);
    return () => {
      alive = false;
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [user, caseId, loadBrief]);

  const handleRefresh = async () => {
    if (!caseId || refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      setBrief(await loadBrief(true));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const handleToggleAutopilot = async () => {
    if (!caseId || !brief || !canManage || autopilotBusy) return;
    setAutopilotBusy(true);
    setError(null);
    try {
      const updated = await updateCase(caseId, { autopilot: !brief.autopilot });
      setBrief((current) => current ? { ...current, autopilot: updated.autopilot ?? !current.autopilot } : current);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAutopilotBusy(false);
    }
  };

  const askQuestion = (question: string) => {
    if (!caseId) return;
    navigate(`/cases/${encodeURIComponent(caseId)}/inquiry?q=${encodeURIComponent(question)}`);
    scrollWorkbenchBodyIntoView();
  };

  const openFindings = () => {
    if (!caseId) return;
    navigate(`/cases/${encodeURIComponent(caseId)}/findings`);
    scrollWorkbenchBodyIntoView();
  };

  const handleCancelBatch = async () => {
    if (!caseId || !canManage || cancellingBatch) return;
    setCancellingBatch(true);
    setError(null);
    try {
      // 复用 jobs 通用取消端点；随即重拉简报以尽快反映取消态（简报轮询亦会补更新）。
      await cancelJob(caseId, "auto-inquiry");
      setBrief(await loadBrief());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCancellingBatch(false);
    }
  };

  const handleStartBatch = async () => {
    if (!caseId || !canManage || restartingBatch) return;
    setRestartingBatch(true);
    setError(null);
    try {
      await autoInquiryJob.start();
      setBrief(await loadBrief());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRestartingBatch(false);
    }
  };

  if (!caseId) return null;

  const generatedAt = brief ? new Date(brief.generatedAt).toLocaleTimeString() : "";

  return (
    <div className="brief">
      <div className="brief-controls">
        <div className="brief-controls__status">
          {brief ? (
            <>
              <span className={`brief-autopilot-dot ${brief.autopilot ? "brief-autopilot-dot--on" : "brief-autopilot-dot--off"}`} />
              <span>自动流水线：{brief.autopilot ? "运行中" : "已暂停"}</span>
              <span className="brief-controls__sep">·</span>
              <span className="brief-controls__muted">概览生成于 {generatedAt}{brief.degraded ? " · 已降级" : ""}</span>
            </>
          ) : (
            <span className="brief-controls__muted">加载中…</span>
          )}
        </div>
        <div className="brief-controls__actions">
          {canManage ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={handleToggleAutopilot} disabled={!brief || autopilotBusy}>
              {autopilotBusy ? "处理中…" : brief?.autopilot ? "暂停自动推进" : "开启自动推进"}
            </button>
          ) : null}
          <button type="button" className="btn btn--ghost btn--sm" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? "重算中…" : "刷新概览"}
          </button>
        </div>
      </div>

      {/* 阶段条并入简报头部（复用 TaskOverview：起草/确认检查点/标记阶段等交互一并保留）。 */}
      <TaskOverview caseId={caseId} enabled={Boolean(user && caseId)} canManage={canManage} />

      {error ? <div className="brief-error">{error}</div> : null}
      {autoInquiryJob.error ? <div className="brief-error">{autoInquiryJob.error}</div> : null}

      {brief ? (
        <>
          <section className="brief-stats" aria-label="素材与加工统计">
            <div className="brief-stat">
              <span>素材</span>
              <strong>{brief.materials.done}/{brief.materials.total}</strong>
              <small>
                {[
                  brief.materials.processing > 0 ? `${brief.materials.processing} 加工中` : "",
                  brief.materials.needsConfig > 0 ? `${brief.materials.needsConfig} 需配置` : "",
                  brief.materials.failed > 0 ? `${brief.materials.failed} 失败` : "",
                ].filter(Boolean).join("，") || "已加工 / 总数"}
              </small>
            </div>
            <div className="brief-stat">
              <span>关键实体</span>
              <strong>{brief.processing.elementCount}</strong>
              <small>抽取的人物/组织/地点等</small>
            </div>
            <div className="brief-stat">
              <span>未处置矛盾</span>
              <strong>{brief.processing.unresolvedContradictionCount}</strong>
              <small>共检出 {brief.processing.contradictionCount} 条</small>
            </div>
            <div className="brief-stat">
              <span>核准结论</span>
              <strong>{brief.processing.approvedFindingCount}/{brief.processing.findingCount}</strong>
              <small>已核准 / 结论池</small>
            </div>
          </section>

          <OverviewBlock brief={brief} onFrame={setFrameCite} caseId={caseId} />

          {frameCite ? (
            <div className="brief-frame">
              <FrameCiteView cite={frameCite} onClose={() => setFrameCite(null)} />
            </div>
          ) : null}

          <BriefSection title="时间线骨架" count={brief.timeline.length} caseId={caseId} tab="elements" tabLabel="展开时间线">
            {brief.timeline.length === 0 ? (
              <div className="brief-empty">尚无可锚定的时间要素。抽取要素后，锚定时间点会在此按序展开。</div>
            ) : (
              <ol className="brief-timeline">
                {brief.timeline.map((point) => (
                  <li key={point.id} className={`brief-timeline__item ${point.sortKey === null ? "brief-timeline__item--loose" : ""}`}>
                    <span className="brief-timeline__label">{point.label}</span>
                    {point.related.length > 0 ? (
                      <span className="brief-timeline__related">{point.related.slice(0, 6).map((r) => r.name).join("、")}</span>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </BriefSection>

          <BriefSection title="关键实体" count={brief.entities.length} caseId={caseId} tab="elements" tabLabel="要素图谱">
            {brief.entities.length === 0 ? (
              <div className="brief-empty">尚未抽取要素。素材加工完成后系统会自动抽取要素并在此列出高频项。</div>
            ) : (
              <div className="brief-entities">
                {brief.entities.map((entity) => (
                  <button
                    key={entity.id}
                    type="button"
                    className={`brief-entity brief-entity--${entity.type}`}
                    onClick={() => {
                      navigate(`/cases/${encodeURIComponent(caseId)}/elements`);
                      scrollWorkbenchBodyIntoView();
                    }}
                    title={`${ELEMENT_TYPE_LABELS[entity.type]} · 出现 ${entity.freq} 次`}
                  >
                    <span className="brief-entity__name">{entity.name}</span>
                    <span className="brief-entity__freq">{entity.freq}</span>
                  </button>
                ))}
              </div>
            )}
          </BriefSection>

          <BriefSection title="未处置矛盾" count={brief.contradictions.length} caseId={caseId} tab="contradictions" tabLabel="去矛盾核验">
            {brief.contradictions.length === 0 ? (
              <div className="brief-empty">当前无未处置的矛盾。检出的矛盾在保密员处置后即从此处移除。</div>
            ) : (
              <div className="brief-contradictions">
                {brief.contradictions.map((c) => (
                  <ContradictionCard key={c.id} c={c} onFrame={setFrameCite} />
                ))}
              </div>
            )}
          </BriefSection>

          <BriefSection title="待核问题" count={brief.openQuestions.length} caseId={caseId} tab="inquiry" tabLabel="去补充核验">
            {brief.autoInquiry && brief.autoInquiry.total > 0 ? (
              <AutoInquiryProgressBlock
                progress={brief.autoInquiry}
                canManage={canManage}
                cancelling={cancellingBatch}
                restarting={restartingBatch}
                onCancel={handleCancelBatch}
                onRestart={handleStartBatch}
                onOpenFindings={openFindings}
              />
            ) : (
              <div className="brief-empty">
                自动研判尚未运行。
                {canManage ? (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={handleStartBatch} disabled={restartingBatch}>
                    {restartingBatch ? "启动中…" : "启动自动研判"}
                  </button>
                ) : null}
              </div>
            )}
            {brief.openQuestions.length === 0 ? (
              <div className="brief-empty">暂无系统建议的待核问题。</div>
            ) : (
              <div className="brief-questions">
                {brief.openQuestions.map((q, i) => (
                  <button
                    key={`${q.category}:${i}`}
                    type="button"
                    className="brief-question"
                    title={`${q.rationale}\n（点击带着该问题去补充核验）`}
                    onClick={() => askQuestion(q.question)}
                  >
                    <span className={`category-tag category-tag--${q.category}`}>
                      {q.category === "basic" ? "基础"
                        : q.category === "timeline" ? "时间线"
                        : q.category === "relationship" ? "关联"
                        : q.category === "contradiction" ? "冲突"
                        : q.category === "verification" ? "待核"
                        : q.category === "analysis" ? "分析"
                        : q.category}
                    </span>
                    <span className="brief-question__text">{q.question}</span>
                  </button>
                ))}
              </div>
            )}
          </BriefSection>

          <BriefSection title="报告覆盖度" caseId={caseId} tab="report" tabLabel="去报告复核">
            <CoverageMeter coverage={brief.coverage} caseId={caseId} />
          </BriefSection>
        </>
      ) : (
        !error ? <div className="brief-empty">简报加载中…</div> : null
      )}
    </div>
  );
}
