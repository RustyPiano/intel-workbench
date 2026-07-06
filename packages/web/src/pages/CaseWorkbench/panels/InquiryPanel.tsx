import React, { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  askInquiryStream,
  clearInquiries,
  getSuggestedQuestions,
  getSuggestedQuestionsLLM,
  listCaseAudit,
  listInquiries,
  markReview,
  type ApiCitation,
  type ApiInquiry,
  type ApiInquiryStreamEvent,
  type ApiQuestionSuggestion,
} from "../../../api";
import { useSession } from "../../../state/session";
import { CitationChips } from "../components/CitationChips";
import { FrameCiteView } from "../components/FrameCiteView";
import { InquiryRunView } from "../components/inquiry/InquiryRunView";
import { supportStatusLabel } from "../components/helpers";

function InquiryAnswer({ inquiry, onFrame, reviewedRefs, onReview }: { inquiry: ApiInquiry; onFrame: (c: ApiCitation) => void; reviewedRefs: Set<string>; onReview: (ref: string) => void }) {
  const claims = inquiry.claims || [];
  if (inquiry.status !== "answered") {
    const unverified = claims.filter((c) => c.status === "unverified");
    const isError = inquiry.status === "error";
    const textColor = isError ? "var(--danger-light)" : "var(--warn-light)";
    return (
      <div style={{ color: textColor, fontSize: "13px", lineHeight: "1.6", display: "inline-flex", alignItems: "flex-start", gap: "6px" }}>
        <svg className="icon-svg" style={{ color: textColor, marginTop: "3px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          {isError ? (
            <>
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </>
          ) : (
            <>
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </>
          )}
        </svg>
        <div>
          {inquiry.answer}
          {unverified.length > 0 ? (
            <div style={{ marginTop: "8px", color: "var(--text-dim)" }}>
              （以下为无有效出处的待核提示，不作为事实）
              {unverified.map((c, i) => {
                const ref = `${inquiry.id}:${claims.indexOf(c)}`;
                return (
                  <div key={i} style={{ marginTop: "4px" }}>
                    · {c.text}
                    {c.support_status ? <span style={{ color: "var(--text-muted)", fontSize: "11px", marginLeft: "6px" }}>{supportStatusLabel(c.support_status)}</span> : null}
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
  const verified = claims.filter((c) => c.status === "verified" || c.support_status === "support-unverified");
  return (
    <div style={{ fontSize: "13px", lineHeight: "1.7" }}>
      {verified.map((c, i) => {
        const ref = `${inquiry.id}:${claims.indexOf(c)}`;
        return (
          <div key={i} style={{ marginBottom: "6px" }}>
            {i + 1}. {c.text}
            {c.support_status === "support-unverified" ? (
              <span style={{ marginLeft: "6px", fontSize: "11px", color: "var(--text-muted)" }}>{supportStatusLabel(c.support_status)}</span>
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

type SuggestionMode = "rule" | "llm";

/** 推荐问题卡片（智能工作流自动化决策文档 §阶段 1.1 / §阶段 2.3）：规则引擎按材料动态生成"快速推荐"，
 * 或经 LLM 生成开放式问题的"深度分析"；点击填入问题、悬停查看推荐理由。 */
function QuestionSuggestionCards({
  suggestions,
  disabled,
  loading,
  mode,
  onModeChange,
  onPick,
}: {
  suggestions: ApiQuestionSuggestion[];
  disabled: boolean;
  loading: boolean;
  mode: SuggestionMode;
  onModeChange: (mode: SuggestionMode) => void;
  onPick: (question: string) => void;
}) {
  return (
    <div className="chat-suggestions-container">
      <div className="chat-suggestions-header">
        <span className="chat-suggestions__label">
          <svg className="icon-svg" style={{ marginRight: "4px", width: "13px", height: "13px", verticalAlign: "middle" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          智能问题推荐
        </span>
        <div className="suggestion-mode-toggle">
          <button
            type="button"
            className={`suggestion-toggle-btn ${mode === "rule" ? "active" : ""}`}
            onClick={() => onModeChange("rule")}
          >
            快速推荐
          </button>
          <button
            type="button"
            className={`suggestion-toggle-btn ${mode === "llm" ? "active" : ""}`}
            onClick={() => onModeChange("llm")}
          >
            深度分析
          </button>
        </div>
      </div>
      <div className="chat-suggestions-list" aria-label="推荐问题列表">
        {loading ? (
          <div className="chat-suggestions-status">
            <span className="spinner-dots">●●●</span> 正在利用 LLM 分析专题线索生成问题...
          </div>
        ) : null}
        {!loading && suggestions.length === 0 ? (
          <div className="chat-suggestions-status">根据当前专题素材，暂无推荐问题</div>
        ) : null}
        {!loading && suggestions.map((s, i) => (
          <button
            key={`${s.category}:${i}`}
            type="button"
            className="chat-suggestion-card"
            title={s.rationale}
            disabled={disabled}
            onClick={() => onPick(s.question)}
          >
            <span className={`category-tag category-tag--${s.category}`}>
              {s.category === "basic" ? "基础" :
               s.category === "timeline" ? "时间线" :
               s.category === "relationship" ? "关联" :
               s.category === "contradiction" ? "冲突" :
               s.category === "verification" ? "待核" :
               s.category === "analysis" ? "分析" : s.category}
            </span>
            <div className="chat-suggestion-card__question">{s.question}</div>
          </button>
        ))}
      </div>
    </div>
  );
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
  const [liveEvents, setLiveEvents] = useState<ApiInquiryStreamEvent[]>([]);
  /** 本会话内已封卷问答的研判过程（内存态，刷新丢失是预期，不做持久化）。 */
  const [processByInquiry, setProcessByInquiry] = useState<Record<string, ApiInquiryStreamEvent[]>>({});
  const [questionSuggestions, setQuestionSuggestions] = useState<ApiQuestionSuggestion[]>([]);
  const [suggestionMode, setSuggestionMode] = useState<SuggestionMode>("rule");
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const streamControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const userStoppedRef = useRef(false);
  /** liveEvents 的同步镜像：done 到达时用它捕获完整过程，规避 setState 闭包滞后。 */
  const liveEventsRef = useRef<ApiInquiryStreamEvent[]>([]);

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
    if (!user || !caseId) return;
    let alive = true;
    setQuestionSuggestions([]);
    setSuggestionsLoading(true);
    const fetchSuggestions = suggestionMode === "llm" ? getSuggestedQuestionsLLM : getSuggestedQuestions;
    fetchSuggestions(caseId)
      .then((list) => alive && setQuestionSuggestions(list))
      .catch(() => { /* best-effort：推荐问题非核心路径，静默失败不阻断问答 */ })
      .finally(() => alive && setSuggestionsLoading(false));
    return () => {
      alive = false;
    };
  }, [user, caseId, suggestionMode]);

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
    liveEventsRef.current = [];
    setLiveEvents([]);
  };

  const handleStreamEvent = (event: ApiInquiryStreamEvent) => {
    if (!mountedRef.current || userStoppedRef.current) return;
    if (event.type === "done") {
      const process = liveEventsRef.current;
      if (process.length > 0) {
        setProcessByInquiry((prev) => ({ ...prev, [event.inquiry.id]: process }));
      }
      setHistory((prev) => [...prev, event.inquiry]);
      clearLiveState();
      return;
    }
    if (event.type === "error") {
      setError(event.message);
      clearLiveState();
      return;
    }
    // token / thinking / tool_* / cite_added / claim_added / budget / finding_submitted / 未知类型
    // 一律入流，由 InquiryRunView 按类型派生；未知类型不落任何派生结果，天然静默忽略。
    liveEventsRef.current = [...liveEventsRef.current, event];
    setLiveEvents(liveEventsRef.current);
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

  const runQuestion = async (q: string, deep = deepMode) => {
    if (!q || !user || !caseId || busy) return;
    userStoppedRef.current = false;
    setBusy(true);
    setError(null);
    setInput("");
    setLiveQuestion(q);
    liveEventsRef.current = [];
    setLiveEvents([]);
    if (deep) setActiveDeep(true);
    const controller = new AbortController();
    streamControllerRef.current = controller;
    try {
      await askInquiryStream(caseId, q, handleStreamEvent, controller.signal, deep);
    } catch (err) {
      if (!userStoppedRef.current && mountedRef.current) {
        setError((err as Error).message);
        clearLiveState();
      }
    } finally {
      if (mountedRef.current) {
        if (streamControllerRef.current === controller) streamControllerRef.current = null;
        setActiveDeep(false);
        setBusy(false);
      }
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    await runQuestion(input.trim());
  };

  const editTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (editTimerRef.current) {
        window.clearTimeout(editTimerRef.current);
      }
    };
  }, []);

  const handleEditQuestion = (question: string) => {
    if (busy) return;
    setInput(question);
    if (editTimerRef.current) {
      window.clearTimeout(editTimerRef.current);
    }
    editTimerRef.current = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
  };

  const handleClearHistory = async () => {
    if (!caseId || busy || history.length === 0) return;
    if (!window.confirm("清空本专题问答记录？此操作不会删除素材。")) return;
    try {
      await clearInquiries(caseId);
      setHistory([]);
      setProcessByInquiry({});
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="inquiry-layout">
      <div className="chat-header">
        <div>
          <strong>补充核验</strong>
          <span>AI 每次只读取当前问题和专题素材；答案需先转入核验池并人工核准后，才可用于报告。</span>
        </div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={handleClearHistory} disabled={busy || history.length === 0}>
          清空记录
        </button>
      </div>
      <div className="chat-messages">
        {history.length === 0 && !busy && !liveQuestion ? (
          <div style={{ color: "var(--text-dim)", fontSize: "13px", lineHeight: "1.7", padding: "8px" }}>
            向 AI 提问本专题已加工素材中的关联线索。每条答案都会绑定到素材出处；无支撑时系统回「现有材料不足以判断」，不臆造。
          </div>
        ) : null}
        {history.map((inq) => (
          <div key={inq.id} className="chat-message-pair">
            <div className="chat-bubble chat-bubble--user">
              <div className="chat-avatar">
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                </svg>
              </div>
              <div className="chat-content">
                <p>{inq.question}</p>
                <div className="chat-actions">
                  <button type="button" onClick={() => void runQuestion(inq.question)} disabled={busy}>重新运行</button>
                  <button type="button" onClick={() => handleEditQuestion(inq.question)} disabled={busy}>编辑问题</button>
                </div>
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
                {processByInquiry[inq.id]?.length ? (
                  <details className="run-process">
                    <summary>
                      <svg className="icon-svg rp-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                      研判过程
                    </summary>
                    <InquiryRunView events={processByInquiry[inq.id]} />
                  </details>
                ) : null}
              </div>
            </div>
          </div>
        ))}
        {liveQuestion ? (
          <div className="chat-message-pair">
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
                <div className="live-status-badge">草稿输出 · 等待引用校验</div>
                {activeDeep ? (
                  <p className="live-narration">深度分析中…（已提高检索/读取预算并开启思维链，可能稍慢）</p>
                ) : null}
                <InquiryRunView events={liveEvents} pending />
              </div>
            </div>
          </div>
        ) : null}
        {busy && !liveQuestion ? (
          <div className="chat-message-pair">
            <div className="chat-bubble chat-bubble--ai chat-bubble--live" style={{ width: "100%" }}>
              <div className="chat-avatar">
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4M8 15h.01M16 15h.01"/>
                </svg>
              </div>
              <div className="chat-content">
                <p className="live-narration">{activeDeep ? "深度分析中…（已提高检索/读取预算，可能稍慢）" : "研判中…"}</p>
              </div>
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

      <QuestionSuggestionCards
        suggestions={questionSuggestions}
        disabled={busy}
        loading={suggestionsLoading}
        mode={suggestionMode}
        onModeChange={setSuggestionMode}
        onPick={handleEditQuestion}
      />

      <form onSubmit={handleSend} className="chat-input-area-new">
        <div className="chat-input-box">
          <input
            type="text"
            className="chat-input-field"
            ref={inputRef}
            placeholder="向 AI 助手提问有关本专题的关联线索…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
          />
          <div className="chat-input-controls">
            <label className="deep-analysis-label">
              <input
                type="checkbox"
                checked={deepMode}
                onChange={(e) => setDeepMode(e.target.checked)}
                disabled={busy}
              />
              <span className="deep-analysis-checkbox-custom"></span>
              <span style={{ fontSize: "11px", fontWeight: 600 }}>深度分析</span>
            </label>
            <div style={{ flex: 1 }} />
            {busy ? (
              <button type="button" className="btn-stop-search" onClick={handleStop}>
                <svg className="icon-svg" style={{ width: "12px", height: "12px", marginRight: "4px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
                停止
              </button>
            ) : null}
            <button type="submit" className="btn-send-message" disabled={busy || !input.trim()}>
              <svg className="icon-svg" style={{ width: "14px", height: "14px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="22" y1="2" x2="11" y2="13"/>
                <polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
