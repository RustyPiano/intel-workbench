import type { CSSProperties } from "react";
import { formatKB, severityLabel, type BudgetVM, type CiteVM, type ClaimVM, type FindingVM } from "./runModel";

/**
 * 证据台账（方向 B 右栏）：三个 side-block——
 * 证据台账（cite_added 累积）、运行预算（budget 驱动）、候选结论（claim_added 草稿 + finding_submitted 候选卡）。
 */
export function EvidenceLedger({ cites, claims, budget, finding }: { cites: CiteVM[]; claims: ClaimVM[]; budget?: BudgetVM; finding?: FindingVM }) {
  const pct = budget && budget.budgetBytes > 0 ? Math.min(100, Math.max(0, Math.round((budget.readBytes / budget.budgetBytes) * 100))) : 0;
  return (
    <>
      <div className="side-block">
        <div className="s-label"><span>证据台账</span><span className="s-count">{cites.length} 条引用</span></div>
        {cites.length === 0 ? (
          <div className="ledger-empty">尚未登记引用</div>
        ) : (
          <div className="ledger">
            {cites.map((c) => (
              <div key={c.citeId} className="ev ev-cite">
                <span className="cite-id mono">{c.citeId}</span>
                <span className="c-mat mono">{c.materialName}</span>
                <span className="c-quote">「{c.quote}」</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="side-block">
        <div className="s-label"><span>运行预算</span></div>
        {budget ? (
          <div className="side-meter">
            {budget.turn != null ? (
              <div className="m-row"><span>轮次</span><span>{budget.turn}{budget.maxTurns != null ? ` / ${budget.maxTurns}` : ""}</span></div>
            ) : null}
            <div className="m-row"><span>读取预算</span><span>{formatKB(budget.readBytes)} KB / {Math.round(budget.budgetBytes / 1024)} KB</span></div>
            <div className="b-bar"><i style={{ "--fill": `${pct}%` } as CSSProperties} /></div>
          </div>
        ) : (
          <div className="ledger-empty">尚未产生用量</div>
        )}
      </div>

      <div className="side-block">
        <div className="s-label"><span>候选结论</span>{claims.length > 0 ? <span className="s-count">{claims.length} 条草稿</span> : null}</div>
        {claims.length === 0 && !finding ? (
          <div className="ledger-empty">尚未提交</div>
        ) : (
          <div className="ledger">
            {claims.map((c) => (
              <div key={c.index} className="side-claim">
                <span className="sc-idx mono">第 {c.index}/{c.total} 条</span> {c.text}
                {c.citeIds.length > 0 ? <div className="sc-cites mono">{c.citeIds.join(" · ")}</div> : null}
              </div>
            ))}
            {finding ? (
              <div className="side-finding">
                <div className="sf-head">
                  <span className="sf-label">候选结论</span>
                  {finding.severity ? <span className="sf-sev">{severityLabel(finding.severity)}</span> : null}
                </div>
                <div>{finding.conclusion}</div>
                <div className="sf-cites mono">支持 {finding.supporting} · 反证 {finding.opposing}</div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}
