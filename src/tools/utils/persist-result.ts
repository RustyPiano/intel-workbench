import { mkdir } from "node:fs/promises";
import path from "node:path";

import { RuntimeError, isRuntimeError } from "../../runtime/errors.js";
import type { ToolContext } from "../types.js";
import { atomicWriteFile } from "./atomic-write.js";

export interface PersistToolResultParams {
  ctx: Pick<ToolContext, "policy" | "fileMutationQueue">;
  outPath: string;
  data: unknown;
}

export interface PersistToolResultResult {
  absPath: string;
  bytesWritten: number;
}

export async function persistToolResult({
  ctx,
  outPath,
  data,
}: PersistToolResultParams): Promise<PersistToolResultResult> {
  let absPath: string;
  try {
    absPath = ctx.policy.resolveWritePath(outPath);
  } catch (error) {
    if (isRuntimeError(error) && error.code === "PATH_NOT_ALLOWED") {
      throw new RuntimeError({
        code: "PATH_NOT_ALLOWED",
        message: `Result path is not writable: ${outPath}. Choose a workspace-writable out_path.`,
        details: error.details,
      });
    }
    throw error;
  }

  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const write = async () => {
    await mkdir(path.dirname(absPath), { recursive: true });
    await atomicWriteFile(absPath, payload, "utf8");
  };

  if (ctx.fileMutationQueue) {
    await ctx.fileMutationQueue.runExclusive(absPath, write);
  } else {
    await write();
  }

  return {
    absPath,
    bytesWritten: Buffer.byteLength(payload, "utf8"),
  };
}
