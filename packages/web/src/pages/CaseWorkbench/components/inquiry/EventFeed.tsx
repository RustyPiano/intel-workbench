import { ToolCard } from "./ToolCard";
import type { FeedItem } from "./runModel";

/** 思考块：默认折叠、弱化样式；模型不出思维链时整场缺失，不留空壳。 */
function ThinkingBlock({ text }: { text: string }) {
  return (
    <details className="ev ev-think">
      <summary>
        <span>思考过程</span>
        <svg className="icon-svg t-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </summary>
      <div className="t-think-body">{text}</div>
    </details>
  );
}

/** 活动流：按事件到达顺序渲染叙述段、思考块、工具卡。 */
export function EventFeed({ feed, pending }: { feed: FeedItem[]; pending?: boolean }) {
  if (feed.length === 0) {
    return (
      <div className="feed">
        <div className="feed-empty">{pending ? "正在研判…" : "无过程记录"}</div>
      </div>
    );
  }
  return (
    <div className="feed">
      {feed.map((item) => {
        if (item.kind === "narration") return <p key={item.key} className="ev ev-narr">{item.text}</p>;
        if (item.kind === "thinking") return <ThinkingBlock key={item.key} text={item.text} />;
        return <ToolCard key={item.key} tool={item.tool} />;
      })}
    </div>
  );
}
