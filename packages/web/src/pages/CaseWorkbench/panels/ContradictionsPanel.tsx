import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  acknowledgeContradiction,
  listContradictions,
  type ApiCitation,
  type ApiClaim,
  type ContradictionAcknowledgementStatus,
  type ContradictionDetectionResult,
} from "../../../api";
import { useSession } from "../../../state/session";
import { CitationChips } from "../components/CitationChips";
import { FrameCiteView } from "../components/FrameCiteView";
import { CONTRADICTION_SCOPE_LABELS } from "../components/helpers";
import { useExtractionJob } from "../hooks/useExtractionJob";

const CONTRADICTION_RULE_LABELS: Record<string, string> = {
  "same-value": "同值跳过",
  "numeric-mismatch": "数值冲突",
  "opposite-status": "状态相反",
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
  const [resolving, setResolving] = useState<string | null>(null);
  const [ackNotes, setAckNotes] = useState<Record<string, string>>({});

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

  const handleAcknowledge = async (contradictionId: string, status: Exclude<ContradictionAcknowledgementStatus, "open">) => {
    if (!user || !caseId || resolving) return;
    const key = `${contradictionId}:${status}`;
    setResolving(key);
    setError(null);
    try {
      await acknowledgeContradiction(caseId, contradictionId, { status, note: (ackNotes[contradictionId] ?? "").trim() });
      void reloadContradictions();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setResolving(null);
    }
  };

  const jobResult = job?.kind === "contradictions" && job.result ? job.result as ContradictionDetectionResult : null;
  const latestResult = jobResult ?? contradictionResult;
  const all = latestResult?.contradictions ?? [];
  const propositions = latestResult?.groundedPropositions ?? [];
  const warnings = latestResult?.warnings ?? [];
  const ruleHits = all.filter((item) => item.rule_source === "rule").length;
  const ackByContradiction = new Map((latestResult?.acknowledgements ?? []).map((ack) => [ack.contradiction_id, ack]));
  const canResolve = user?.role === "security" || user?.role === "admin";
  const running = job?.state === "running";
  const total = job?.progress.total ?? 0;
  const done = job?.progress.done ?? 0;
  const progressWidth = running && total > 0 ? `${Math.min(100, Math.round((done / total) * 100))}%` : "38%";
  const notStarted = Boolean(latestResult?.notStarted);
  const noProcessedChunks = !notStarted && latestResult !== null && latestResult.totalChunks === 0;
  const statusLabel = notStarted ? "未检测" : noProcessedChunks ? "未执行" : latestResult?.status === "failed" ? "失败" : latestResult?.status === "degraded" ? "部分覆盖完成" : latestResult ? "完成" : "未检测";

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
          {notStarted ? `可检测素材块 ${latestResult.totalChunks} 个` : `覆盖 ${latestResult.processedChunks}/${latestResult.totalChunks} 个素材块`} · 状态：{statusLabel}
          {propositions.length > 0 ? ` · 证据陈述 ${propositions.length} 条` : ""}
          {ruleHits > 0 ? ` · 规则命中 ${ruleHits} 条` : ""}
          {latestResult.truncated ? " · 覆盖不完整" : ""}
          {warnings.length > 0 ? ` · ${warnings.join("；")}` : ""}
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

      {propositions.length > 0 ? (
        <details className="proposition-panel">
          <summary>证据陈述（{propositions.length}）</summary>
          <div className="proposition-list">
            {propositions.slice(0, 20).map((claim, index) => (
              <div key={`${claim.chunk_id}:${index}`} className="proposition-row">
                <div>
                  <strong>{claim.entity}</strong>
                  <span>{claim.attribute}: {claim.value}</span>
                  {claim.normalized_entity !== claim.entity || claim.normalized_attribute !== claim.attribute ? (
                    <small>归一键：{claim.normalized_entity} · {claim.normalized_attribute}</small>
                  ) : null}
                  {claim.normalized_value !== claim.value ? (
                    <small>归一值：{claim.normalized_value}</small>
                  ) : null}
                </div>
                <CitationChips claim={citedClaim(claim.text, claim.citation)} onFrame={setFrameCite} />
              </div>
            ))}
            {propositions.length > 20 ? <div className="proposition-more">仅显示前 20 条</div> : null}
          </div>
        </details>
      ) : null}

      <div className="contradictions-list">
        {latestResult === null ? (
          <div style={{ color: "var(--text-muted)", padding: "40px", textAlign: "center" }}>加载中…</div>
        ) : latestResult.status === "failed" ? (
          <div style={{ color: "var(--text-muted)", padding: "40px", textAlign: "center", lineHeight: "1.7" }}>
            矛盾检测失败，未产出可复核结果。
          </div>
        ) : notStarted ? (
          <div style={{ color: "var(--text-muted)", padding: "40px", textAlign: "center", lineHeight: "1.7" }}>
            尚未执行矛盾检测。点击「检测矛盾」后系统会读取已加工素材块并生成可复核结果。
          </div>
        ) : noProcessedChunks ? (
          <div style={{ color: "var(--text-muted)", padding: "40px", textAlign: "center", lineHeight: "1.7" }}>
            暂无可检测的已加工素材块。请先完成文档解析或媒体加工。
          </div>
        ) : all.length === 0 ? (
          <div style={{ color: "var(--text-muted)", padding: "40px", textAlign: "center", lineHeight: "1.7" }}>
            检测完成，未发现矛盾线索。
          </div>
        ) : (
          all.map((item) => {
            const ack = ackByContradiction.get(item.id);
            const ackStatus = ack?.status ?? "open";
            const unresolvedHigh = item.confidence >= 0.75 && ackStatus === "open";
            return (
              <div key={item.id} className="contradiction-row" style={unresolvedHigh ? { borderLeft: "3px solid var(--danger-light)" } : undefined}>
                <div className="contradiction-row__head">
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700 }}>{item.attribute ? `${item.entity} · ${item.attribute}` : item.entity}</div>
                    {(item.normalized_entity || item.normalized_attribute || item.value_a || item.value_b) ? (
                      <div className="contradiction-meta">
                        {item.normalized_entity ? `归一实体 ${item.normalized_entity}` : ""}
                        {item.normalized_attribute ? ` · 归一属性 ${item.normalized_attribute}` : ""}
                        {item.value_a || item.value_b ? ` · 归一值 ${item.value_a ?? "?"} / ${item.value_b ?? "?"}` : ""}
                      </div>
                    ) : null}
                  </div>
                  <div style={{ display: "inline-flex", gap: "8px", alignItems: "center", flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {unresolvedHigh ? (
                      <span className="badge badge--devmode" style={{ padding: "3px 8px", fontSize: "11px" }}>未解决</span>
                    ) : ackStatus !== "open" ? (
                      <span className="badge badge--offline" style={{ padding: "3px 8px", fontSize: "11px" }}>{ackStatus === "resolved" ? "已解决" : "已忽略"}</span>
                    ) : null}
                    <span className={`contradiction-scope contradiction-scope--${item.scope === "cross-material" ? "cross" : "intra"}`}>
                      {CONTRADICTION_SCOPE_LABELS[item.scope]}
                    </span>
                    {item.rule_source ? (
                      <span className={`contradiction-rule contradiction-rule--${item.rule_source}`}>
                        {item.rule_source === "rule" ? (CONTRADICTION_RULE_LABELS[item.rule_name ?? ""] ?? "规则判定") : "LLM 判定"}
                      </span>
                    ) : null}
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
                {item.confidence >= 0.75 ? (
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                    <input
                      type="text"
                      placeholder="处理说明（可选）"
                      value={ackNotes[item.id] ?? ""}
                      onChange={(e) => setAckNotes((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      disabled={!canResolve || ackStatus !== "open" || Boolean(resolving)}
                      style={{ minWidth: "220px", flex: "1 1 220px", background: "rgba(255, 255, 255, 0.01)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text)", padding: "5px 8px", fontSize: "12px" }}
                    />
                    <button
                      type="button"
                      className="btn"
                      style={{ padding: "4px 10px", fontSize: "12px" }}
                      disabled={!canResolve || Boolean(resolving) || ackStatus !== "open"}
                      title={canResolve ? "标记为已解决" : "仅保密员或管理员可处理矛盾"}
                      onClick={() => handleAcknowledge(item.id, "resolved")}
                    >
                      {resolving === `${item.id}:resolved` ? "处理中…" : "解决"}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      style={{ padding: "4px 10px", fontSize: "12px" }}
                      disabled={!canResolve || Boolean(resolving) || ackStatus !== "open"}
                      title={canResolve ? "驳回或忽略该矛盾" : "仅保密员或管理员可处理矛盾"}
                      onClick={() => handleAcknowledge(item.id, "dismissed")}
                    >
                      {resolving === `${item.id}:dismissed` ? "处理中…" : "驳回/忽略"}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {frameCite ? <FrameCiteView cite={frameCite} onClose={() => setFrameCite(null)} /> : null}
    </div>
  );
}
