import { useMemo } from "react";
import type { ApiInquiryStreamEvent } from "../../../../api";
import { EventFeed } from "./EventFeed";
import { EvidenceLedger } from "./EvidenceLedger";
import { buildRunModel } from "./runModel";

/**
 * 方向 B 工作台：左栏活动流 + 右栏证据台账。
 * 实况（pending）与历史「研判过程」回放共用；窄屏（≤860px）纵向堆叠。
 */
export function InquiryRunView({ events, pending }: { events: ApiInquiryStreamEvent[]; pending?: boolean }) {
  const model = useMemo(() => buildRunModel(events), [events]);
  return (
    <div className="run-view">
      <div className="b-grid">
        <div className="b-main">
          <EventFeed feed={model.feed} pending={pending} />
        </div>
        <aside className="b-side">
          <EvidenceLedger cites={model.cites} claims={model.claims} budget={model.budget} finding={model.finding} />
        </aside>
      </div>
    </div>
  );
}
