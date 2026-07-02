import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, useParams } from "react-router-dom";
import {
  createFinding,
  getCase,
  listFindings,
  listInquiries,
  reviewFinding,
  type ApiCase,
  type ApiCitation,
  type ApiClaim,
  type ApiFinding,
  type ApiInquiry,
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

function isPromotableClaim(claim: ApiClaim): boolean {
  if (claim.citations.length === 0) return false;
  if (claim.support_status === "unsupported") return false;
  return claim.support_status === "supported" || claim.support_status === "support-unverified" || claim.status === "verified";
}

function averageCitationConfidence(claim: ApiClaim): number {
  if (claim.citations.length === 0) return 0.5;
  return claim.citations.reduce((sum, citation) => sum + citation.confidence, 0) / claim.citations.length;
}

export function FindingsPanel() {
  const { id: caseId } = useParams<{ id: string }>();
  const { user } = useSession();
  const [caseInfo, setCaseInfo] = useState<ApiCase | null>(null);
  const [findings, setFindings] = useState<ApiFinding[]>([]);
  const [inquiries, setInquiries] = useState<ApiInquiry[]>([]);
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
      const [nextCase, nextFindings, nextInquiries] = await Promise.all([
        getCase(caseId),
        listFindings(caseId),
        listInquiries(caseId),
      ]);
      if (!isMounted.current) return;
      setCaseInfo(nextCase);
      setFindings(nextFindings);
      setInquiries(nextInquiries);
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
  const createTitle = canCreate ? "生成研判结论" : "仅专题创建者或管理员可生成研判结论";
  const reviewTitle = canReview ? "复核研判结论" : "仅保密员或管理员可复核研判结论";
  const inquiryPath = caseId ? `/cases/${encodeURIComponent(caseId)}/inquiry` : "../inquiry";
  const claimRows = inquiries.flatMap((inquiry) =>
    inquiry.claims.map((claim, index) => ({ inquiry, claim, ref: `${inquiry.id}:${index}` })).filter((row) => isPromotableClaim(row.claim)),
  );

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

  return (
    <div className="findings-layout">
      <div className="contradictions-list">
        {!loaded ? (
          <div style={{ color: "var(--text-muted)", padding: "40px", textAlign: "center" }}>加载研判结论…</div>
        ) : findings.length === 0 ? (
          <div style={{ color: "var(--text-muted)", padding: "40px", textAlign: "center", lineHeight: "1.8" }}>
            <div>先去溯源问答生成带引用结论。</div>
            <NavLink to={inquiryPath} className="btn" style={{ marginTop: "12px", padding: "6px 12px", fontSize: "12px" }}>
              去溯源问答
            </NavLink>
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
        <div className="report-sidebar__title">从问答结论生成研判</div>
        {!loaded ? (
          <div style={{ color: "var(--text-muted)", fontSize: "12px", lineHeight: "1.7" }}>加载问答结论…</div>
        ) : claimRows.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: "12px", lineHeight: "1.7" }}>
            先去溯源问答生成带引用结论。
            <NavLink to={inquiryPath} className="btn" style={{ marginTop: "10px", padding: "5px 10px", fontSize: "12px" }}>
              去溯源问答
            </NavLink>
          </div>
        ) : (
          claimRows.map(({ claim, ref }) => (
            <div key={ref} style={{ borderBottom: "1px solid var(--border)", paddingBottom: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontSize: "13px", lineHeight: "1.6" }}>
                {claim.text}
                <CitationChips claim={claim} onFrame={setFrameCite} />
              </div>
              <button type="button" className="btn btn--primary" style={{ padding: "5px 10px", fontSize: "12px" }} disabled={Boolean(busy) || !canCreate} title={createTitle} onClick={() => handleCreate(claim, ref)}>
                {busy === `create:${ref}` ? "生成中…" : "生成研判结论"}
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
