import type { RunEvent } from "../runtime/trace.js";

export interface TimelineRenderOptions {
  mode: "compact" | "verbose";
  showPlan?: boolean;
  hideDebug?: boolean;
}

function labelForEvent(event: RunEvent): string | null {
  switch (event.type) {
    case "planning_summary":
      return "plan";
    case "skill_activated":
      return "skill";
    case "tool_started":
    case "tool_progress":
    case "tool_completed":
      return "tool";
    case "artifact_created":
      return "artifact";
    case "assistant_completed":
      return "result";
    case "run_completed":
      return "run";
    case "run_failed":
      return "error";
    case "run_cancelled":
      return "run";
    case "run_started":
      return "run";
    default:
      return null;
  }
}

function shouldRenderEvent(event: RunEvent, options: TimelineRenderOptions): boolean {
  if (event.level === "debug" && options.mode === "compact") {
    return false;
  }

  if (event.type === "planning_summary" && options.showPlan === false) {
    return false;
  }

  if (options.mode === "verbose") {
    return options.hideDebug ? event.level !== "debug" : true;
  }

  return [
    "run_started",
    "planning_summary",
    "skill_activated",
    "tool_started",
    "tool_completed",
    "artifact_created",
    "assistant_completed",
    "run_completed",
    "run_failed",
    "run_cancelled",
  ].includes(event.type);
}

function formatCompactLine(event: RunEvent): string | null {
  const label = labelForEvent(event);
  if (!label) {
    return null;
  }

  if (event.type === "run_failed") {
    const layer = typeof event.data?.error_layer === "string" ? event.data.error_layer : "runtime";
    const userMessage = typeof event.data?.user_message === "string" ? event.data.user_message : event.summary;
    return `[error] ${layer}: ${userMessage}`;
  }

  return `[${label}] ${event.summary}`;
}

function formatVerboseLine(event: RunEvent): string | null {
  const label = labelForEvent(event) ?? event.phase;
  const parts = [`[${label}] ${event.summary}`];

  if (typeof event.data?.provider === "string") {
    parts.push(`provider=${event.data.provider}`);
  }
  if (typeof event.data?.model === "string") {
    parts.push(`model=${event.data.model}`);
  }
  if (typeof event.data?.args_preview === "string") {
    parts.push(`args=${event.data.args_preview}`);
  }
  if (typeof event.data?.chunk_preview === "string") {
    parts.push(`chunk=${event.data.chunk_preview}`);
  }
  if (typeof event.data?.result_preview === "string") {
    parts.push(`result=${event.data.result_preview}`);
  }
  if (typeof event.data?.stdout_tail === "string" && event.data.stdout_tail) {
    parts.push(`stdout=${event.data.stdout_tail}`);
  }
  if (typeof event.data?.stderr_tail === "string" && event.data.stderr_tail) {
    parts.push(`stderr=${event.data.stderr_tail}`);
  }
  if (typeof event.data?.debug_message === "string") {
    parts.push(`debug=${event.data.debug_message}`);
  }
  if (typeof event.data?.duration_ms === "number") {
    parts.push(`duration_ms=${event.data.duration_ms}`);
  }
  if (typeof event.data?.log_path === "string") {
    parts.push(`log=${event.data.log_path}`);
  }
  if (typeof event.data?.path === "string" && event.type === "artifact_created") {
    parts.push(`path=${event.data.path}`);
  }

  return parts.join(" | ");
}

export function renderTimeline(events: RunEvent[], options: TimelineRenderOptions): string[] {
  return events
    .filter((event) => shouldRenderEvent(event, options))
    .map((event) => (options.mode === "verbose" ? formatVerboseLine(event) : formatCompactLine(event)))
    .filter((line): line is string => Boolean(line));
}
