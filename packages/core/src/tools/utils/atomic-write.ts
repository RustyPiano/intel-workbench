import { randomBytes } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { RuntimeError } from "../../runtime/errors.js";

export type AtomicWriteEncoding = BufferEncoding;

/**
 * Write `content` to `filePath` atomically by writing to a sibling temp file
 * and renaming it into place. The temp filename uses a random suffix so
 * concurrent writers within the same millisecond cannot collide.
 *
 * If the rename fails the temp file is best-effort removed before re-throwing.
 */
export async function atomicWriteFile(
  filePath: string,
  content: string | Buffer,
  encoding: AtomicWriteEncoding = "utf8",
  signal?: AbortSignal,
): Promise<void> {
  const parentDir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const suffix = randomBytes(6).toString("hex");
  const tempPath = path.join(parentDir, `.${baseName}.${suffix}.tmp`);

  try {
    if (signal?.aborted) {
      throw new RuntimeError({ code: "RUN_ABORTED", message: "Write aborted before commit", retriable: true });
    }
    if (typeof content === "string") {
      await writeFile(tempPath, content, encoding);
    } else {
      await writeFile(tempPath, content);
    }
    if (signal?.aborted) {
      throw new RuntimeError({ code: "RUN_ABORTED", message: "Write aborted before commit", retriable: true });
    }
    await rename(tempPath, filePath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors; the original error is more useful.
    }
    throw error;
  }
}
