import { useEffect, useState } from "react";
import {
  listMaterials,
  listContradictions,
  getReport,
  listCaseAudit,
  type ApiCase,
  type ApiMaterial,
  type ApiReport,
  type AuditEvent,
  type ContradictionDetectionResult,
} from "../../../api";
import { CLEARANCE_LABELS } from "../../../types";
import { needsMaterialConfig, REPORT_STATUS_LABELS } from "./helpers";

export interface VerificationSummaryState {
  materials: ApiMaterial[];
  contradictions: ContradictionDetectionResult | null;
  report: ApiReport | null;
  audit: AuditEvent[];
}

export function VerificationSummary({ caseInfo, caseId, enabled }: { caseInfo: ApiCase | null; caseId?: string; enabled: boolean }) {
  const [state, setState] = useState<VerificationSummaryState | null>(null);

  useEffect(() => {
    if (!enabled || !caseId) return;
    let alive = true;
    const load = () => {
      Promise.all([
        listMaterials(caseId).catch(() => [] as ApiMaterial[]),
        listContradictions(caseId).catch(() => null),
        getReport(caseId).catch(() => null),
        listCaseAudit(caseId).catch(() => [] as AuditEvent[]),
      ]).then(([materials, contradictions, report, audit]) => {
        if (alive) setState({ materials, contradictions, report, audit });
      });
    };
    load();
    const timer = window.setInterval(load, 5000);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [caseId, enabled]);

  if (!enabled) return null;
  const materialTotal = state?.materials.length ?? caseInfo?.materials.length ?? 0;
  const done = state?.materials.filter((item) => item.status === "done").length ?? 0;
  const processing = state?.materials.filter((item) => item.status === "processing").length ?? 0;
  const pending = state?.materials.filter((item) => item.status === "pending").length ?? 0;
  const needsConfig = state?.materials.filter((item) => item.status === "pending" && needsMaterialConfig(item.note)).length ?? 0;
  const pendingOther = Math.max(0, pending - needsConfig);
  const failed = state?.materials.filter((item) => item.status === "failed").length ?? 0;
  const materialHint = [
    processing > 0 ? `${processing} 个加工中` : "",
    needsConfig > 0 ? `${needsConfig} 个需配置` : "",
    pendingOther > 0 ? `${pendingOther} 个待处理` : "",
    failed > 0 ? `${failed} 个失败` : "",
  ].filter(Boolean).join("，") || "已加工 / 总数";
  const contradictions = state?.contradictions?.contradictions ?? [];
  const ackById = new Map((state?.contradictions?.acknowledgements ?? []).map((ack) => [ack.contradiction_id, ack.status]));
  const openHigh = contradictions.filter((item) => item.confidence >= 0.75 && (ackById.get(item.id) ?? "open") === "open").length;
  const reportStatus = state?.report?.status;
  const auditIssues = state?.audit.filter((event) => event.result !== "ok" && !event.action.startsWith("tool.")).length ?? 0;
  const toolIssues = state?.audit.filter((event) => event.result !== "ok" && event.action.startsWith("tool.")).length ?? 0;

  return (
    <section className="verification-summary">
      <div className="verification-summary__item">
        <span>管素材</span>
        <strong>{done}/{materialTotal}</strong>
        <small>{materialHint}</small>
      </div>
      <div className="verification-summary__item">
        <span>查矛盾</span>
        <strong>{contradictions.length}</strong>
        <small>{openHigh > 0 ? `${openHigh} 个高置信待处理` : "无高置信未处理"}</small>
      </div>
      <div className="verification-summary__item">
        <span>看证据</span>
        <strong>{caseInfo?.clearance ? CLEARANCE_LABELS[caseInfo.clearance] : "—"}</strong>
        <small>引用片段可定位回原文</small>
      </div>
      <div className="verification-summary__item">
        <span>出报告</span>
        <strong>{reportStatus ? REPORT_STATUS_LABELS[reportStatus] : "未生成"}</strong>
        <small>{reportStatus === "approved" || reportStatus === "exported" ? "导出前仍过闸门" : "需提交并复核"}</small>
      </div>
      <div className="verification-summary__item">
        <span>审计</span>
        <strong>{state?.audit.length ?? "—"}</strong>
        <small>{auditIssues > 0 ? `${auditIssues} 条拒绝/失败/异常` : toolIssues > 0 ? `${toolIssues} 次工具校验未通过` : "专题链路留痕"}</small>
      </div>
    </section>
  );
}
