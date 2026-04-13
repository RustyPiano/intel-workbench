import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { RuntimeError, toRuntimeErrorShape } from "../runtime/errors.js";
import type { RuntimeTool } from "./types.js";

interface WriteArgs {
  path: string;
  content: string;
  create_dirs?: boolean;
  overwrite?: boolean;
}

interface WriteData {
  path: string;
  bytesWritten: number;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export const writeTool: RuntimeTool<WriteArgs, WriteData> = {
  name: "write",
  description: "Write the full contents of a file.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      create_dirs: { type: "boolean" },
      overwrite: { type: "boolean" },
    },
    required: ["path", "content"],
  },
  async execute(args, ctx) {
    const queue = ctx.fileMutationQueue;

    if (!queue) {
      throw new Error("writeTool requires fileMutationQueue in ToolContext");
    }

    try {
      const filePath = ctx.policy.resolveWritePath(args.path);
      const parentDir = path.dirname(filePath);

      return await queue.runExclusive(filePath, async () => {
        if (args.create_dirs) {
          await mkdir(parentDir, { recursive: true });
        }

        if (!args.create_dirs && !(await fileExists(parentDir))) {
          throw new RuntimeError({
            code: "FILE_NOT_FOUND",
            message: `Parent directory does not exist: ${parentDir}`,
          });
        }

        if ((await fileExists(filePath)) && args.overwrite === false) {
          throw new RuntimeError({
            code: "INVALID_ARGS",
            message: "Refusing to overwrite existing file without overwrite=true",
          });
        }

        const tempPath = path.join(parentDir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
        await writeFile(tempPath, args.content, "utf8");
        await rename(tempPath, filePath);

        return {
          ok: true,
          content: `Wrote ${args.content.length} bytes to ${args.path}`,
          meta: {
            path: filePath,
            bytesWritten: Buffer.byteLength(args.content, "utf8"),
          },
        };
      });
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : "Failed to write file",
        error: toRuntimeErrorShape(error, "INTERNAL_ERROR"),
      };
    }
  },
};
