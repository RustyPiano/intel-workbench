import { renderTimeline, type TimelineRenderOptions } from "./timeline.js";
import type { LoadedRunTrace } from "../runtime/trace.js";

export interface RunTraceReportOptions extends TimelineRenderOptions {
  format: "timeline" | "json" | "jsonl" | "markdown";
}

export function formatRunTraceReport(trace: LoadedRunTrace, options: RunTraceReportOptions): string {
  if (options.format === "json") {
    return `${JSON.stringify(trace, null, 2)}\n`;
  }

  if (options.format === "jsonl") {
    return `${trace.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  }

  const timeline = renderTimeline(trace.events, options);

  if (options.format === "markdown") {
    const lines = [
      `# Run ${trace.meta.run_id}`,
      "",
      `- status: ${trace.meta.status}`,
      `- trace: ${trace.status}`,
      `- session: ${trace.meta.session_id ?? "(none)"}`,
      `- provider: ${trace.meta.provider ?? "(unknown)"}`,
      `- model: ${trace.meta.model ?? "(unknown)"}`,
      "",
      "## Timeline",
      ...timeline.map((line) => `- ${line}`),
    ];
    if (trace.status !== "valid") {
      lines.push("", "## Repair Notes", ...trace.repairNotes.map((note) => `- ${note}`));
    }
    return `${lines.join("\n")}\n`;
  }

  const lines = [
    `run\t${trace.meta.run_id}`,
    `status\t${trace.meta.status}`,
    `trace_status\t${trace.status}`,
    `session\t${trace.meta.session_id ?? "(none)"}`,
    `provider\t${trace.meta.provider ?? "(unknown)"}`,
    `model\t${trace.meta.model ?? "(unknown)"}`,
    "",
    ...timeline,
  ];
  if (trace.status !== "valid") {
    lines.push("", ...trace.repairNotes.map((note) => `repair\t${note}`));
  }
  return `${lines.join("\n")}\n`;
}

export function formatSessionTraceReport(
  input: { sessionId: string; sessionStatus?: string; runTraces: LoadedRunTrace[] },
  options: TimelineRenderOptions,
): string {
  if (input.runTraces.length === 0) {
    return `session\t${input.sessionId}\nsession_status\t${input.sessionStatus ?? "unknown"}\ntrace\t(no trace data)\n`;
  }

  const lines = [`session\t${input.sessionId}`, `session_status\t${input.sessionStatus ?? "unknown"}`];
  for (const trace of input.runTraces) {
    lines.push("", `run\t${trace.meta.run_id}`, `trace_status\t${trace.status}`, ...renderTimeline(trace.events, options));
    if (trace.status !== "valid") {
      lines.push(...trace.repairNotes.map((note) => `repair\t${note}`));
    }
  }

  return `${lines.join("\n")}\n`;
}
