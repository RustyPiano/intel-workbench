import readline from "node:readline/promises";
import process from "node:process";

import type { RuntimeAgent } from "../runtime/agent.js";

export interface ReplOptions {
  agent: RuntimeAgent;
  sessionId?: string;
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

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
      if (result.finalMessage.content) {
        console.log(result.finalMessage.content);
      }
    }
  } finally {
    rl.close();
    options.agent.eventBus.emit({ type: "agent_end", sessionId: conversation.sessionId });
  }
}
