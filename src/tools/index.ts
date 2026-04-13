import type { ToolCall } from "../runtime/types.js";
import { activateSkillTool } from "./activate-skill.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { readTool } from "./read.js";
import type { RuntimeTool, ToolContext } from "./types.js";
import { writeTool } from "./write.js";

export class ToolRegistry {
  private readonly tools = new Map<string, RuntimeTool>();

  constructor(tools: RuntimeTool[]) {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  list(): RuntimeTool[] {
    return [...this.tools.values()];
  }

  async execute(toolCall: ToolCall, ctx: ToolContext) {
    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolCall.name}`);
    }

    return tool.execute(toolCall.arguments, ctx);
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry([readTool, writeTool, editTool, bashTool, activateSkillTool]);
}
