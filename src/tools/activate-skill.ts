import { RuntimeError, toRuntimeErrorShape } from "../runtime/errors.js";
import type { RuntimeTool } from "./types.js";

interface ActivateSkillArgs {
  name: string;
}

interface ActivateSkillData {
  name: string;
  rootDir: string;
  contentHash: string;
  newlyActivated: boolean;
}

export const activateSkillTool: RuntimeTool<ActivateSkillArgs, ActivateSkillData> = {
  name: "activate_skill",
  description: "Load the full contents of a discovered skill.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
    },
    required: ["name"],
  },
  async execute(args, ctx) {
    try {
      if (!ctx.skillRegistry) {
        throw new RuntimeError({
          code: "SKILL_NOT_FOUND",
          message: `Skill registry is not available for ${args.name}`,
        });
      }

      const activated = await ctx.skillRegistry.activate(args.name);
      return {
        ok: true,
        content: activated.renderedContent,
        data: {
          name: activated.record.meta.name,
          rootDir: activated.record.meta.rootDir,
          contentHash: activated.state.contentHash,
          newlyActivated: activated.newlyActivated,
        },
      };
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : "Failed to activate skill",
        error: toRuntimeErrorShape(error, "SKILL_NOT_FOUND"),
      };
    }
  },
};
