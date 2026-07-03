import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, useParams } from "react-router-dom";
import {
  applySuggestedFinding,
  createFinding,
  getCase,
  getSuggestedFindings,
  listFindings,
  listInquiries,
  reviewFinding,
  type ApiCase,
  type ApiCitation,
  type ApiClaim,
  type ApiFinding,
  type ApiFindingSuggestion,
  type ApiInquiry,
  type FindingSuggestionSource,
} from "../../../api";
import { useSession } from "../../../state/session";
import { CitationChips } from "../components/CitationChips";
import { FrameCiteView } from "../components/FrameCiteView";
import { supportStatusLabel } from "../components/helpers";

const FINDING_STATUS_LABELS: Record<ApiFinding["review_status"], string> = {
  draft: "待复核",
  approved: "已核准",
  rejected: "已驳回",
};

const SUGGESTION_SOURCE_LABELS: Record<FindingSuggestionSource, string> = {
  inquiry: "问答答案",
  contradiction: "矛盾线索",
  "element-timeline": "时间线锚点",
};

function isPromotableClaim(claim: ApiClaim): boolean {
  if (claim.citations.length === 0) return false;
  if (claim.support_status === "unsupported") return false;
  return claim.support_status === "supported" || claim.support_status === "support-unverified" || claim.status === "verified";
}

function averageCitationConfidence(claim: ApiClaim): number {
  const citations = claim.citations.filter((citation) => citation.support_status !== "unsupported");
  if (citations.length === 0) return 0.5;
  return citations.reduce((sum, citation) => sum + citation.confidence, 0) / citations.length;
}

export function FindingsPanel() {
  const { id: caseId } = useParams<{ id: string }>();
  const { user } = useSession();
  const [caseInfo, setCaseInfo] = useState<ApiCase | null>(null);
  const [findings, setFindings] = useState<ApiFinding[]>([]);
  const [inquiries, setInquiries] = useState<ApiInquiry[]>([]);
  const [findingSuggestions, setFindingSuggestions] = useState<ApiFindingSuggestion[]>([]);
  const [dismissedSuggestionIds, setDismissedSuggestionIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [frameCite, setFrameCite] = useState<ApiCitation | null>(null);
  const [loaded, setLoaded] = useState(false);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!user || !caseId) return;
    try {
      const [nextCase, nextFindings, nextInquiries, nextSuggestions] = await Promise.all([
        getCase(caseId),
        listFindings(caseId),
        listInquiries(caseId),
        getSuggestedFindings(caseId).catch(() => []), // best-effort：建议非核心路径，拉取失败不阻断核验池展示
      ]);
      if (!isMounted.current) return;
      setCaseInfo(nextCase);
      setFindings(nextFindings);
      setInquiries(nextInquiries);
      setFindingSuggestions(nextSuggestions);
      setError(null);
    } catch (e) {
      if (!isMounted.current) return;
      setError((e as Error).message);
    } finally {
      if (isMounted.current) {
        setLoaded(true);
      }
    }
  }, [user, caseId]);

  useEffect(() => {
    setLoaded(false);
    void load();
  }, [load]);

  const canCreate = Boolean(user && (user.role === "admin" || caseInfo?.owner === user.id));
  const canReview = user?.role === "security" || user?.role === "admin";
  const createTitle = canCreate ? "加入核验池，等待人工复核" : "仅专题创建者或管理员可加入核验池";
  const reviewTitle = canReview ? "核准后可进入报告复核" : "仅保密员或管理员可复核核验池条目";
  const inquiryPath = caseId ? `/cases/${encodeURIComponent(caseId)}/inquiry` : "../inquiry";
  const claimRows = inquiries.flatMap((inquiry) =>
    inquiry.claims.map((claim, index) => ({ inquiry, claim, ref: `${inquiry.id}:${index}` })).filter((row) => isPromotableClaim(row.claim)),
  );
  const visibleSuggestions = findingSuggestions.filter((s) => !dismissedSuggestionIds.has(s.id));
  const knownConclusionTexts = new Set([
    ...findingSuggestions.map((suggestion) => suggestion.conclusion.trim()),
    ...findings.map((finding) => finding.conclusion.trim()),
  ]);
  const availableClaimRows = claimRows.filter(({ claim }) => !knownConclusionTexts.has(claim.text.trim()));

  const handleCreate = async (claim: ApiClaim, ref: string) => {
    if (!caseId || busy) return;
    setBusy(`create:${ref}`);
    setError(null);
    try {
      await createFinding(caseId, { claim, confidence: averageCitationConfidence(claim) });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const handleReview = async (findingId: string, review_status: "approved" | "rejected") => {
    if (!caseId || busy) return;
    setBusy(`${review_status}:${findingId}`);
    setError(null);
    try {
      await reviewFinding(caseId, findingId, review_status);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const handleAdoptSuggestion = async (suggestion: ApiFindingSuggestion) => {
    if (!caseId || busy) return;
    setBusy(`adopt:${suggestion.id}`);
    setError(null);
    try {
      await applySuggestedFinding(caseId, suggestion);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const handleAdoptAll = async () => {
    if (!caseId || busy || visibleSuggestions.length === 0) return;
    setBusy("adopt-all");
    setError(null);
    const failures: string[] = [];
    for (const suggestion of visibleSuggestions) {
      try {
        await applySuggestedFinding(caseId, suggestion);
      } catch (e) {
        failures.push((e as Error).message);
      }
    }
    if (failures.length > 0) setError(`部分候选加入失败：${failures[0]}`);
    await load();
    setBusy(null);
  };

  const handleDismissSuggestion = (suggestionId: string) => {
    setDismissedSuggestionIds((prev) => new Set(prev).add(suggestionId));
  };

  return (
    <div className="findings-layout">
      <div className="contradictions-list">
        <div className="contradiction-row" style={{ background: "rgba(14, 165, 233, 0.04)", borderColor: "rgba(56, 189, 248, 0.25)" }}>
          <div className="contradiction-row__head">
            <div style={{ fontWeight: 700 }}>结论核验</div>
            <span className="badge" style={{ padding: "3px 8px", fontSize: "11px" }}>报告前置步骤</span>
          </div>
          <div style={{ color: "var(--text-dim)", fontSize: "13px", lineHeight: "1.7" }}>
            本页把带出处的问答答案、矛盾核验结果和时间线建议整理成核验池条目。转入核验池后先人工核准，已核准结论才会进入报告复核。
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", color: "var(--text-muted)", fontSize: "12px" }}>
            <span>待入池候选：系统建议，尚未入池</span>
            <span>核验池：等待核准或驳回</span>
            <span>已核准：报告可引用</span>
          </div>
        </div>

        {loaded && visibleSuggestions.length > 0 ? (
          <div className="contradiction-row" style={{ borderColor: "var(--accent-light)" }}>
            <div className="contradiction-row__head">
              <div>
                <div style={{ fontWeight: 700 }}>待入池候选（{visibleSuggestions.length}）</div>
                <div style={{ color: "var(--text-dim)", fontSize: "12px", marginTop: "3px" }}>系统根据问答、矛盾和时间线给出的建议；加入后进入下方核验池，不会直接写入报告。</div>
              </div>
              <button
                type="button"
                className="btn btn--primary"
                style={{ padding: "4px 10px", fontSize: "12px" }}
                disabled={Boolean(busy) || !canCreate}
                title={createTitle}
                onClick={handleAdoptAll}
              >
                {busy === "adopt-all" ? "加入中…" : "全部加入核验池"}
              </button>
            </div>
            {visibleSuggestions.map((suggestion) => (
              <div key={suggestion.id} style={{ borderTop: "1px solid var(--border)", paddingTop: "10px", marginTop: "10px", display: "flex", flexDirection: "column", gap: "6px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", lineHeight: "1.6" }}>
                  <span className="badge" style={{ padding: "2px 8px", fontSize: "11px" }}>{SUGGESTION_SOURCE_LABELS[suggestion.source]}</span>
                  {suggestion.conclusion}
                </div>
                <div style={{ color: "var(--text-dim)", fontSize: "12px" }}>
                  置信度 {Math.round(suggestion.confidence * 100)}% · {suggestion.reasoning}
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    type="button"
                    className="btn btn--primary"
                    style={{ padding: "4px 10px", fontSize: "12px" }}
                    disabled={Boolean(busy) || !canCreate}
                    title={createTitle}
                    onClick={() => handleAdoptSuggestion(suggestion)}
                  >
                    {busy === `adopt:${suggestion.id}` ? "加入中…" : "加入核验池"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    style={{ padding: "4px 10px", fontSize: "12px" }}
                    disabled={Boolean(busy)}
                    onClick={() => handleDismissSuggestion(suggestion.id)}
                  >
                    暂不使用
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <div style={{ padding: "14px 18px 0", color: "var(--text-dim)", fontSize: "12px", lineHeight: "1.6" }}>
          <div style={{ color: "var(--text)", fontWeight: 700, fontSize: "13px" }}>核验池（{findings.length}）</div>
          <div>这里是已加入、待复核或已核准的结论；已核准后报告可引用。</div>
        </div>
        {!loaded ? (
          <div style={{ color: "var(--text-muted)", padding: "40px", textAlign: "center" }}>加载结论…</div>
        ) : findings.length === 0 ? (
          <div style={{ color: "var(--text-muted)", padding: "40px", textAlign: "center", lineHeight: "1.8" }}>
            <div>{visibleSuggestions.length > 0 ? "还没有加入核验池。请先从上方待入池候选点“加入核验池”。" : "暂无核验池条目。先去补充核验生成带引用答案，再转入核验池。"}</div>
            {visibleSuggestions.length === 0 ? (
              <NavLink to={inquiryPath} className="btn" style={{ marginTop: "12px", padding: "6px 12px", fontSize: "12px" }}>
                去补充核验
              </NavLink>
            ) : null}
          </div>
        ) : (
          findings.map((finding) => (
            <div key={finding.id} className="contradiction-row">
              <div className="contradiction-row__head">
                <div style={{ fontWeight: 700 }}>{finding.conclusion}</div>
                <span className={`badge ${finding.review_status === "approved" ? "badge--offline" : finding.review_status === "rejected" ? "badge--devmode" : ""}`} style={{ padding: "3px 8px", fontSize: "11px" }}>
                  {FINDING_STATUS_LABELS[finding.review_status]}
                </span>
              </div>
              <div style={{ color: "var(--text-dim)", fontSize: "12px" }}>置信度 {Math.round(finding.confidence * 100)}%</div>
              <div style={{ fontSize: "13px", lineHeight: "1.7" }}>
                支持引用
                <CitationChips claim={{ text: finding.conclusion, type: "fact", status: "verified", citations: finding.supporting_citations }} onFrame={setFrameCite} />
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", fontSize: "11px", color: "var(--text-muted)" }}>
                {finding.supporting_citations.map((citation, index) => (
                  <span key={`${citation.material_id}:${citation.content_hash}:${index}`}>
                    引用 {index + 1} 支持状态：{citation.support_status ? supportStatusLabel(citation.support_status) : "未标注"}
                  </span>
                ))}
              </div>
              {finding.opposing_citations.length > 0 ? (
                <div style={{ fontSize: "13px", lineHeight: "1.7", color: "var(--text-dim)" }}>
                  相反引用
                  <CitationChips claim={{ text: finding.conclusion, type: "fact", status: "verified", citations: finding.opposing_citations }} onFrame={setFrameCite} />
                </div>
              ) : null}
              <div style={{ display: "flex", gap: "8px" }}>
                <button type="button" className="btn" style={{ padding: "4px 10px", fontSize: "12px" }} disabled={Boolean(busy) || !canReview || finding.review_status === "approved"} title={reviewTitle} onClick={() => handleReview(finding.id, "approved")}>
                  核准
                </button>
                <button type="button" className="btn btn--danger" style={{ padding: "4px 10px", fontSize: "12px" }} disabled={Boolean(busy) || !canReview || finding.review_status === "rejected"} title={reviewTitle} onClick={() => handleReview(finding.id, "rejected")}>
                  驳回
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="report-sidebar" style={{ overflow: "auto" }}>
        <div>
          <div className="report-sidebar__title">问答答案补充</div>
          <div style={{ color: "var(--text-dim)", fontSize: "12px", lineHeight: "1.7", marginTop: "10px" }}>
            这里显示尚未进入待入池候选或核验池的带引用问答答案。确认可用时，转入核验池。
          </div>
        </div>
        {!loaded ? (
          <div style={{ color: "var(--text-muted)", fontSize: "12px", lineHeight: "1.7" }}>加载问答答案…</div>
        ) : availableClaimRows.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: "12px", lineHeight: "1.7" }}>
            {claimRows.length > 0 ? "可用问答答案已在左侧待入池候选或核验池中。" : "先去补充核验生成带引用答案，再转入核验池。"}
            {claimRows.length === 0 ? (
              <NavLink to={inquiryPath} className="btn" style={{ marginTop: "10px", padding: "5px 10px", fontSize: "12px" }}>
                去补充核验
              </NavLink>
            ) : null}
          </div>
        ) : (
          availableClaimRows.map(({ claim, ref }) => (
            <div key={ref} style={{ borderBottom: "1px solid var(--border)", paddingBottom: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontSize: "13px", lineHeight: "1.6" }}>
                {claim.text}
                <CitationChips claim={claim} onFrame={setFrameCite} />
              </div>
              <button type="button" className="btn btn--primary" style={{ padding: "5px 10px", fontSize: "12px" }} disabled={Boolean(busy) || !canCreate} title={createTitle} onClick={() => handleCreate(claim, ref)}>
                {busy === `create:${ref}` ? "转入中…" : "转入核验池"}
              </button>
            </div>
          ))
        )}
        {error ? <div style={{ color: "var(--danger-light)", fontSize: "12px" }}>{error}</div> : null}
      </div>

      {frameCite ? <FrameCiteView cite={frameCite} onClose={() => setFrameCite(null)} /> : null}
    </div>
  );
}
