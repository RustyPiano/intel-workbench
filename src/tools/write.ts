import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { RuntimeError, toRuntimeErrorShape } from "../runtime/errors.js";
import { atomicWriteFile } from "./utils/atomic-write.js";
import type { RuntimeTool } from "./types.js";

const writeArgsSchema = z
  .object({
    path: z.string(),
    content: z.string(),
    create_dirs: z.boolean().optional(),
    overwrite: z.boolean().optional(),
  })
  .strict();

type WriteArgs = z.infer<typeof writeArgsSchema>;

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
  inputSchema: writeArgsSchema,
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

        await atomicWriteFile(filePath, args.content, "utf8");

        return {
          ok: true,
          content: `Wrote ${args.content.length} bytes to ${args.path}`,
          meta: {
            path: filePath,
            bytesWritten: Buffer.byteLength(args.content, "utf8"),
          },
          artifacts: [
            {
              type: "file",
              path: args.path,
              description: "Written file",
            },
          ],
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
