import { useEffect, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import {
  approveReport,
  draftReport,
  exportReport,
  generateFindingSuggestions,
  generateAutoDraft,
  getReport,
  getReportCoverage,
  listFindings,
  submitReport,
  type ApiFinding,
  type ApiReport,
  type ApiReportCoverage,
  type DraftReportInput,
} from "../../../api";
import { useSession } from "../../../state/session";
import { useWorkbenchContext } from "../../CaseWorkbench";
import { CLEARANCE_LABELS } from "../../../types";
import { CoverageMeter } from "../components/CoverageMeter";
import {
  gateReasonGloss,
  REPORT_STEPS,
  specToBody,
} from "../components/helpers";

export function ReportPanel() {
  const { id: caseId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useSession();
  const { refreshStatus } = useWorkbenchContext();
  const canReview = user?.role === "security" || user?.role === "admin";

  const [report, setReport] = useState<ApiReport | null>(null);
  const [coverage, setCoverage] = useState<ApiReportCoverage | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [approvedFindings, setApprovedFindings] = useState<ApiFinding[]>([]);
  const [selectedFindingIds, setSelectedFindingIds] = useState<string[]>([]);
  const [generatedSections, setGeneratedSections] = useState<DraftReportInput["sections"] | null>(null);
  const [gateReasons, setGateReasons] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [preparingFindings, setPreparingFindings] = useState(false);

  useEffect(() => {
    if (!user || !caseId) return;
    let alive = true;
    setLoaded(false);
    // 覆盖度获取失败不阻塞报告编辑（引导性信息，缺失即不展示仪表）。
    Promise.all([getReport(caseId), listFindings(caseId), getReportCoverage(caseId).catch(() => null)])
      .then(([r, fs, cov]) => {
        if (!alive) return;
        setApprovedFindings(fs.filter((finding) => finding.review_status === "approved"));
        setCoverage(cov);
        setReport(r);
        if (r) {
          setTitle(r.spec.title);
          setBody(specToBody(r));
          setSelectedFindingIds([...new Set(r.spec.sections.flatMap((section) => section.finding_ids ?? []))]);
          setGeneratedSections(null);
        } else {
          setTitle("");
          setBody("");
          setSelectedFindingIds([]);
          setGeneratedSections(null);
        }
        setLoaded(true);
      })
      .catch((e: Error) => {
        if (!alive) return;
        setError(e.message);
        setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [user, caseId]);

  const run = async (fn: () => Promise<ApiReport>) => {
    if (!user || !caseId || busy) return;
    setBusy(true);
    setError(null);
    setGateReasons([]);
    try {
      const next = await fn();
      setReport(next);
      setTitle(next.spec.title);
      setBody(specToBody(next));
      setSelectedFindingIds([...new Set(next.spec.sections.flatMap((section) => section.finding_ids ?? []))]);
      setGeneratedSections(null);
      refreshStatus();
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
    const finding_ids = selectedFindingIds.filter((findingId) => approvedFindings.some((finding) => finding.id === findingId));
    void run(() => draftReport(
      caseId!,
      generatedSections?.length
        ? { title: title.trim(), sections: generatedSections }
        : finding_ids.length > 0
          ? { title: title.trim(), finding_ids }
          : { title: title.trim(), body },
    ));
  };

  const handleExport = async () => {
    if (!user || !caseId) return;
    setBusy(true);
    setError(null);
    setGateReasons([]);
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
      refreshStatus();
    } catch (e) {
      const reasons = ((e as Error & { result?: { reasons?: string[] } }).result?.reasons ?? []);
      setGateReasons(reasons);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateAutoDraft = async () => {
    if (!user || !caseId || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const draft = await generateAutoDraft(caseId);
      const sectionFindingIds = [...new Set((draft.sections ?? []).flatMap((section) => section.finding_ids ?? []))];
      setTitle(draft.title || '');
      setBody(draft.sections?.map(s => `## ${s.heading}\n\n${s.body}`).join('\n\n') || '');
      setSelectedFindingIds(sectionFindingIds);
      setGeneratedSections(draft.sections ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const handlePrepareFindings = async () => {
    if (!user || !caseId || preparingFindings) return;
    setPreparingFindings(true);
    setError(null);
    try {
      await generateFindingSuggestions(caseId);
      refreshStatus();
      navigate(`/cases/${encodeURIComponent(caseId)}/findings`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPreparingFindings(false);
    }
  };

  const status = report?.status ?? "draft";
  const stepIndex = REPORT_STEPS.findIndex((s) => s.status === status);
  const reportFindingIds = new Set(report?.spec.sections.flatMap((section) => section.finding_ids ?? []) ?? []);
  const coveredApprovedCount = approvedFindings.filter((finding) => reportFindingIds.has(finding.id)).length;
  const freshnessAt = status === "exported" ? report?.exported_at ?? report?.approved_at : report?.approved_at;
  const freshnessAtMs = freshnessAt ? Date.parse(freshnessAt) : NaN;
  const hasNewApprovedFindings = Boolean(
    report
      && (status === "approved" || status === "exported")
      && Number.isFinite(freshnessAtMs)
      && approvedFindings.some((finding) => finding.reviewed_at && Date.parse(finding.reviewed_at) > freshnessAtMs),
  );
  const hasCoverageGap = Boolean(report && approvedFindings.length > 0 && coveredApprovedCount < approvedFindings.length);
  const classificationLabel = report?.spec.classification
    ? CLEARANCE_LABELS[report.spec.classification as keyof typeof CLEARANCE_LABELS] ?? report.spec.classification
    : "";
  const noApprovedFindings = loaded && approvedFindings.length === 0;
  const findingsPath = caseId ? `/cases/${encodeURIComponent(caseId)}/findings` : "../findings";
  const submitReason = !report
    ? "先基于已核准结论生成报告。"
    : !report.rendered
      ? "公文渲染未完成，请先重新保存草稿。"
    : noApprovedFindings
      ? "提交前需先去结论核验，至少核准一条结论。"
      : status !== "draft"
        ? "只有草稿状态可以提交复核。"
        : "";
  const reviewReason = report && !report.rendered
    ? "公文渲染未完成，不能核准。"
    : noApprovedFindings
      ? "复核前需先去结论核验，至少核准一条结论。"
    : status !== "in_review"
      ? "仅待复核状态可以核准。"
      : "";
  const toggleFinding = (findingId: string) => {
    setGeneratedSections(null);
    setSelectedFindingIds((prev) => prev.includes(findingId) ? prev.filter((id) => id !== findingId) : [...prev, findingId]);
  };

  return (
    <div className="report-layout">
      <div className="report-editor">
        {coverage ? <CoverageMeter coverage={coverage} caseId={caseId!} /> : null}
        <div className="report-toolbar">
          <span style={{ fontSize: "12px", color: "var(--text-dim)" }}>
            状态：<strong style={{ color: "var(--accent-light)" }}>{REPORT_STEPS[stepIndex]?.label ?? "草稿起草"}</strong>
            {classificationLabel ? ` · 密级 ${classificationLabel}` : ""}
            {report && !report.rendered ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", marginLeft: "8px", color: "var(--danger-light)" }}>
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                公文渲染未完成，已禁止提交、核准与导出
              </span>
            ) : ""}
          </span>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn--primary" style={{ padding: "4px 12px", fontSize: "12px" }} onClick={handleSaveDraft} disabled={busy}>
            {busy ? "处理中…" : report ? "保存修改（回草稿）" : "生成草稿"}
          </button>
        </div>

        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "10px 12px", color: "var(--text-dim)", fontSize: "12px", lineHeight: "1.6", marginBottom: "12px", background: "rgba(255, 255, 255, 0.02)" }}>
          <strong style={{ color: "var(--text)" }}>报告草稿</strong>：主题取自当前专题；正文只使用右侧勾选的已核准结论。<strong style={{ color: "var(--text)" }}>结论</strong> 是核验池中带引用、经复核的事实判断。
        </div>

        <input type="text" className="report-title-input" placeholder="报告标题，例如：关于某网络入侵事件的情况通报" value={title} onChange={(e) => setTitle(e.target.value)} />

        {(hasNewApprovedFindings || hasCoverageGap) && (
          <div style={{ border: "1px solid rgba(245,158,11,0.45)", background: "rgba(120,53,15,0.18)", borderRadius: "var(--radius)", padding: "10px 12px", color: "var(--warn-light)", fontSize: "12px", lineHeight: "1.6", marginBottom: "12px" }}>
            {hasNewApprovedFindings ? <div>报告核准/导出后又出现新的已核准结论，请重新生成或保存草稿后再复核。</div> : null}
            {hasCoverageGap ? <div>当前报告覆盖 {coveredApprovedCount}/{approvedFindings.length} 条已核准结论，请重新生成或保存草稿以纳入遗漏结论。</div> : null}
          </div>
        )}

        {!report && loaded && (
          <div className="report-auto-draft" style={{
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "16px",
            marginBottom: "16px",
            background: "var(--bg-dim)"
          }}>
            <h3 style={{ margin: "0 0 8px 0", fontSize: "14px", fontWeight: 600, display: "flex", alignItems: "center", gap: "6px" }}>
              基于已核准结论自动起草
            </h3>
            <p style={{ margin: "0 0 12px 0", fontSize: "12px", color: "var(--text-muted)", lineHeight: "1.5" }}>
              仅使用已核准结论进行报告组装。若有新结论，需先前往「结论核验」进行核准。
            </p>

            <button
              type="button"
              className="btn btn--primary"
              style={{ width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
              onClick={handleGenerateAutoDraft}
              disabled={generating || approvedFindings.length === 0}
              title={approvedFindings.length === 0 ? "需要至少一条已核准结论" : "自动起草报告"}
            >
              {generating ? (
                <>生成中...</>
              ) : (
                <>
                  自动生成报告草稿
                </>
              )}
            </button>
            {approvedFindings.length === 0 && (
              <p style={{ margin: "8px 0 0 0", fontSize: "11px", color: "var(--text-muted)", textAlign: "center" }}>
                需要至少一条已核准结论才能生成报告
              </p>
            )}
          </div>
        )}

        <textarea
          className="report-textarea"
          placeholder={selectedFindingIds.length > 0 ? "已选择核准结论，保存后将自动组装为报告段落。" : "填写报告正文内容，保存后将渲染为标准公文格式。"}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            setGeneratedSections(null);
          }}
          disabled={selectedFindingIds.length > 0}
        />
        <div style={{ color: "var(--text-muted)", fontSize: "12px", paddingTop: "6px" }}>
          当前仅支持基于已核准结论自动生成报告内容
        </div>
        {error ? <div style={{ color: "var(--danger-light)", fontSize: "12px", padding: "8px 0" }}>{error}</div> : null}
        {gateReasons.length > 0 ? (
          <div style={{ border: "1px solid rgba(248,113,113,0.35)", background: "rgba(127,29,29,0.22)", borderRadius: "var(--radius)", padding: "10px 12px", color: "var(--danger-light)", fontSize: "12px", display: "flex", flexDirection: "column", gap: "4px" }}>
            {gateReasons.map((reason) => (
              <div key={reason} style={{ display: "flex", gap: "8px", alignItems: "baseline", flexWrap: "wrap" }}>
                <span>{gateReasonGloss(reason)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="report-sidebar">
        <div className="report-sidebar__title">报告复核状态</div>

        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={{ color: "var(--text-dim)", fontSize: "12px" }}>已核准结论</div>
          {approvedFindings.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: "12px", lineHeight: "1.7", display: "flex", flexDirection: "column", gap: "8px" }}>
              <span>暂无已核准结论。先自动发现候选结论，加入核验池并核准后，才能生成报告。</span>
              <button type="button" className="btn btn--primary" style={{ width: "fit-content", padding: "5px 10px", fontSize: "12px" }} disabled={preparingFindings} onClick={handlePrepareFindings}>
                {preparingFindings ? "发现中…" : "自动发现候选结论"}
              </button>
              <NavLink to={findingsPath} style={{ width: "fit-content", color: "var(--text-muted)", fontSize: "12px", textDecoration: "underline", textUnderlineOffset: "3px" }}>
                打开结论核验
              </NavLink>
            </div>
          ) : approvedFindings.map((finding) => (
            <label key={finding.id} style={{ display: "flex", gap: "8px", alignItems: "flex-start", color: "var(--text-dim)", fontSize: "12px", lineHeight: "1.5" }}>
              <input type="checkbox" checked={selectedFindingIds.includes(finding.id)} onChange={() => toggleFinding(finding.id)} disabled={busy} />
              <span>{finding.conclusion}</span>
            </label>
          ))}
        </div>

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
              <button type="button" className="btn btn--primary" style={{ width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px" }} disabled={busy || !report || !report.rendered || status !== "draft" || noApprovedFindings} title={submitReason || "提交保密员复核"} onClick={() => run(() => submitReport(caseId!))}>
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
                提交保密员复核
              </button>
              {submitReason ? <span style={{ color: "var(--text-muted)", fontSize: "12px", lineHeight: "1.5" }}>{submitReason}</span> : null}
              {canReview ? (
                <button type="button" className="btn" style={{ width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px" }} disabled={busy || !report?.rendered || status !== "in_review" || noApprovedFindings} title={reviewReason || "核准报告"} onClick={() => run(() => approveReport(caseId!))}>
                  <svg className="icon-svg" style={{ color: "var(--ok-light)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                  复核核准
                </button>
              ) : null}
              {canReview && reviewReason ? <span style={{ color: "var(--text-muted)", fontSize: "12px", lineHeight: "1.5" }}>{reviewReason}</span> : null}
              <button
                type="button"
                className={status === "approved" || status === "exported" ? "btn btn--primary" : "btn btn--danger"}
                style={{ width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                disabled={busy || !report || !report.rendered}
                title={!report?.rendered ? "公文渲染未完成，禁止导出" : status === "approved" || status === "exported" ? "导出公文 .md" : "点击测试导出校验：未复核会拒绝并写审计"}
                onClick={handleExport}
              >
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                {status === "approved" || status === "exported" ? "导出报告 (.md)" : "测试导出校验"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
