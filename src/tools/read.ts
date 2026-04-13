import { readFile, stat } from "node:fs/promises";

import { toRuntimeErrorShape } from "../runtime/errors.js";
import type { RuntimeTool } from "./types.js";

interface ReadArgs {
  path: string;
  offset?: number;
  limit?: number;
}

interface ReadData {
  path: string;
  offset: number;
  limit: number;
  truncated: boolean;
  size: number;
}

export const readTool: RuntimeTool<ReadArgs, ReadData> = {
  name: "read",
  description: "Read a UTF-8 text file within the workspace.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    try {
      const filePath = ctx.policy.resolveReadPath(args.path);
      const fileStat = await stat(filePath);
      const offset = Math.max(0, args.offset ?? 0);
      const limit = Math.max(1, Math.min(args.limit ?? ctx.config.readMaxBytes, ctx.config.readMaxBytes));
      const content = await readFile(filePath, "utf8");
      const sliced = content.slice(offset, offset + limit);

      return {
        ok: true,
        content: sliced,
        data: {
          path: filePath,
          offset,
          limit,
          truncated: offset + limit < content.length,
          size: fileStat.size,
        },
      };
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : "Failed to read file",
        error: toRuntimeErrorShape(error, "FILE_NOT_FOUND"),
      };
    }
  },
};
