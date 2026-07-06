import { useNavigate } from "react-router-dom";

import type { ApiReportCoverage } from "../../../api";
import { scrollWorkbenchBodyIntoView } from "./helpers";

/**
 * 报告覆盖率仪表（阶段三 M4 / 计划 D4）。简报与报告页共用组件：总览（满足节数 / 总节数）+
 * 分节进度条 + 五节清单（满足打勾并给明细；缺口给明细 + 深链跳对应 Tab 补证据）。只做展示与
 * 引导，不参与导出硬门禁。数据来自服务端现算（brief.coverage 或 GET /report/coverage）。
 */
export function CoverageMeter({ coverage, caseId }: { coverage: ApiReportCoverage; caseId: string }) {
  const navigate = useNavigate();
  const jump = (tab: string) => {
    navigate(`/cases/${encodeURIComponent(caseId)}/${tab}`);
    scrollWorkbenchBodyIntoView();
  };
  return (
    <div className="coverage-meter">
      <div className="coverage-meter__head">
        <span className="coverage-meter__label">报告覆盖度</span>
        <span className="coverage-meter__score">
          {coverage.satisfiedCount}/{coverage.totalSections}
        </span>
      </div>
      <div className="coverage-meter__bar" aria-hidden="true">
        {coverage.sections.map((s) => (
          <span key={s.key} className={`coverage-meter__seg coverage-meter__seg--${s.satisfied ? "ok" : "gap"}`} />
        ))}
      </div>
      <ul className="coverage-meter__list">
        {coverage.sections.map((s) => (
          <li key={s.key} className={`coverage-item coverage-item--${s.satisfied ? "ok" : "gap"}`}>
            <span className="coverage-item__icon" aria-hidden="true">
              {s.satisfied ? "✓" : "!"}
            </span>
            <div className="coverage-item__body">
              <span className="coverage-item__title">{s.title}</span>
              <span className="coverage-item__detail">{s.detail}</span>
            </div>
            {s.satisfied ? null : (
              <button type="button" className="coverage-item__action" onClick={() => jump(s.action.tab)}>
                {s.action.label} →
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
