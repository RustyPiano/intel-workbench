import type { ApiCase, CaseStatusPayload } from "../../../api";
import { CLEARANCE_LABELS, type LoadState } from "../../../types";
import { REPORT_STATUS_LABELS, statusTile } from "./helpers";

/**
 * 专题状态一览条：纯渲染 CaseWorkbench 下发的 status（单一状态源），自身不发请求、不轮询。
 * 各节按三态渲染——error 显示"状态不可读取：<message>"，not_started 显示"未开始"，
 * 绝不用假 0 值冒充失败或未开始（原 Promise.all + .catch(() => []) 会把请求失败渲染成 0/0）。
 */
export function VerificationSummary({ caseInfo, status }: { caseInfo: ApiCase | null; status: LoadState<CaseStatusPayload> }) {
  const materials = statusTile(status, (d) => d.materials, (m) => ({
    main: `${m.processed}/${m.total}`,
    hint: m.failed > 0 ? `${m.failed} 个失败` : "已加工 / 总数",
  }));
  const contradictions = statusTile(status, (d) => d.contradictions, (c) => ({
    main: String(c.total),
    hint: c.openHighConfidence > 0 ? `${c.openHighConfidence} 个高置信待处理` : "无高置信未处理",
  }));
  const report = statusTile(status, (d) => d.report, (r) => ({
    main: REPORT_STATUS_LABELS[r.status],
    hint: r.status === "approved" || r.status === "exported" ? "导出前仍过闸门" : "需提交并复核",
  }));
  const audit = statusTile(status, (d) => d.audit, (a) => ({
    main: String(a.count),
    hint: "专题链路留痕",
  }));

  return (
    <section className="verification-summary">
      <div className="verification-summary__item">
        <span>管素材</span>
        <strong>{materials.main}</strong>
        <small>{materials.hint}</small>
      </div>
      <div className="verification-summary__item">
        <span>查矛盾</span>
        <strong>{contradictions.main}</strong>
        <small>{contradictions.hint}</small>
      </div>
      <div className="verification-summary__item">
        <span>看证据</span>
        <strong>{caseInfo?.clearance ? CLEARANCE_LABELS[caseInfo.clearance] : "—"}</strong>
        <small>引用片段可定位回原文</small>
      </div>
      <div className="verification-summary__item">
        <span>出报告</span>
        <strong>{report.main}</strong>
        <small>{report.hint}</small>
      </div>
      <div className="verification-summary__item">
        <span>审计</span>
        <strong>{audit.main}</strong>
        <small>{audit.hint}</small>
      </div>
    </section>
  );
}
