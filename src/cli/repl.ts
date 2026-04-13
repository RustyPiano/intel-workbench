import readline from "node:readline/promises";
import process from "node:process";

import { renderTimeline } from "./timeline.js";
import type { RuntimeAgent } from "../runtime/agent.js";
import { createTraceSummary } from "../runtime/trace.js";

export interface ReplOptions {
  agent: RuntimeAgent;
  sessionId?: string;
  traceMode?: "compact" | "verbose" | "json";
  showPlan?: boolean;
  hideDebug?: boolean;
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  if (options.traceMode === "json") {
    options.agent.eventBus.subscribe((event) => {
      console.log(JSON.stringify(event));
    });
  } else {
    options.agent.eventBus.subscribe((event) => {
      const lines = renderTimeline([event], {
        mode: options.traceMode === "verbose" ? "verbose" : "compact",
        showPlan: options.showPlan,
        hideDebug: options.hideDebug,
      });
      for (const line of lines) {
        console.log(line);
      }
    });
  }

  const conversation = await options.agent.createConversation(options.sessionId);

  try {
    while (true) {
      const input = (await rl.question("mini-agent> ")).trim();
      if (!input) {
        continue;
      }

      if (input === "exit" || input === "quit" || input === ":q") {
        break;
      }

      const result = await conversation.send(input);
      const summary = createTraceSummary(result.finalMessage.content);
      if (
        options.traceMode !== "json" &&
        result.finalMessage.content &&
        (result.finalMessage.content.includes("\n") || summary !== result.finalMessage.content)
      ) {
        console.log(result.finalMessage.content);
      }
    }
  } finally {
    rl.close();
  }
}
