import type { ApiInquiryStreamEvent, ApiToolDetail } from "../../../../api";

/**
 * 把「补充核验」流式事件（事件协议 v2）折叠为方向 B 工作台的视图模型：
 * 左栏活动流（feed）+ 右栏证据台账（cites / claims / budget / finding）。
 * 未知事件类型（含 tool_call_delta）不落入任何派生结果，天然静默忽略（前向兼容）。
 */

export interface ToolCallVM {
  callId: string;
  name: string;
  title: string;
  argsSummary: string;
  status: "running" | "ok" | "failed";
  summary?: string;
  detail?: ApiToolDetail;
  elapsedMs?: number;
}

export type FeedItem =
  | { kind: "narration"; key: string; text: string }
  | { kind: "thinking"; key: string; text: string }
  | { kind: "tool"; key: string; tool: ToolCallVM };

export interface CiteVM {
  citeId: string;
  materialName: string;
  quote: string;
}

export interface ClaimVM {
  index: number;
  total: number;
  text: string;
  citeIds: string[];
}

export interface BudgetVM {
  readBytes: number;
  budgetBytes: number;
  turn?: number;
  maxTurns?: number;
}

export interface FindingVM {
  conclusion: string;
  severity?: "low" | "medium" | "high";
  supporting: number;
  opposing: number;
}

export interface RunModel {
  feed: FeedItem[];
  cites: CiteVM[];
  claims: ClaimVM[];
  budget?: BudgetVM;
  finding?: FindingVM;
}

export function buildRunModel(events: ApiInquiryStreamEvent[]): RunModel {
  const feed: FeedItem[] = [];
  const toolIndexByCallId = new Map<string, number>();
  const cites: CiteVM[] = [];
  const claims: ClaimVM[] = [];
  let budget: BudgetVM | undefined;
  let finding: FindingVM | undefined;

  events.forEach((ev, i) => {
    switch (ev.type) {
      case "token": {
        const last = feed[feed.length - 1];
        if (last && last.kind === "narration") last.text += ev.text;
        else feed.push({ kind: "narration", key: `n${i}`, text: ev.text });
        break;
      }
      case "thinking": {
        const last = feed[feed.length - 1];
        if (last && last.kind === "thinking") last.text += ev.text;
        else feed.push({ kind: "thinking", key: `t${i}`, text: ev.text });
        break;
      }
      case "tool_start": {
        toolIndexByCallId.set(ev.call_id, feed.length);
        feed.push({
          kind: "tool",
          key: `c${ev.call_id}`,
          tool: { callId: ev.call_id, name: ev.name, title: ev.title || ev.name, argsSummary: ev.args_summary, status: "running" },
        });
        break;
      }
      case "tool_result": {
        const idx = toolIndexByCallId.get(ev.call_id);
        const status = ev.ok ? "ok" : "failed";
        const at = idx != null ? feed[idx] : undefined;
        if (at && at.kind === "tool") {
          feed[idx!] = {
            kind: "tool",
            key: at.key,
            tool: { ...at.tool, name: ev.name, status, summary: ev.summary, detail: ev.detail, elapsedMs: ev.elapsed_ms },
          };
        } else {
          // 无配对的 tool_start（不应发生）：兜底原位追加，避免结果丢失。
          feed.push({
            kind: "tool",
            key: `c${ev.call_id}`,
            tool: { callId: ev.call_id, name: ev.name, title: ev.name, argsSummary: "", status, summary: ev.summary, detail: ev.detail, elapsedMs: ev.elapsed_ms },
          });
        }
        break;
      }
      case "cite_added":
        cites.push({ citeId: ev.cite_id, materialName: ev.material_name, quote: ev.quote });
        break;
      case "claim_added":
        claims.push({ index: ev.claim_index, total: ev.total, text: ev.text, citeIds: ev.cite_ids });
        break;
      case "budget":
        budget = { readBytes: ev.read_bytes, budgetBytes: ev.budget_bytes, turn: ev.turn, maxTurns: ev.max_turns };
        break;
      case "finding_submitted":
        finding = { conclusion: ev.conclusion, severity: ev.severity, supporting: ev.supporting, opposing: ev.opposing };
        break;
      default:
        break; // token_call_delta / done / error / 未知类型 → 忽略
    }
  });

  return { feed, cites, claims, budget, finding };
}

export function formatElapsed(ms?: number): string {
  if (ms == null) return "";
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatKB(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

export function severityLabel(sev: FindingVM["severity"]): string {
  if (sev === "high") return "严重度 · 高";
  if (sev === "medium") return "严重度 · 中";
  if (sev === "low") return "严重度 · 低";
  return "";
}
