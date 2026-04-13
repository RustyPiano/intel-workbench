import { open, stat } from "node:fs/promises";

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

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0b1100_0000) === 0b1000_0000;
}

function utf8SequenceLength(byte: number | undefined): number {
  if (byte === undefined) {
    return 0;
  }
  if ((byte & 0b1000_0000) === 0) {
    return 1;
  }
  if ((byte & 0b1110_0000) === 0b1100_0000) {
    return 2;
  }
  if ((byte & 0b1111_0000) === 0b1110_0000) {
    return 3;
  }
  if ((byte & 0b1111_1000) === 0b1111_0000) {
    return 4;
  }

  return 1;
}

function alignUtf8Slice(buffer: Buffer, bytesRead: number): { start: number; end: number } {
  let start = 0;
  while (start < bytesRead && isContinuationByte(buffer[start])) {
    start += 1;
  }

  let end = bytesRead;
  if (end > start) {
    let lastSequenceStart = end - 1;
    while (lastSequenceStart > start && isContinuationByte(buffer[lastSequenceStart])) {
      lastSequenceStart -= 1;
    }

    if (lastSequenceStart + utf8SequenceLength(buffer[lastSequenceStart]) > end) {
      end = lastSequenceStart;
    }
  }

  return { start, end };
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
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    try {
      const filePath = ctx.policy.resolveReadPath(args.path);
      const fileStat = await stat(filePath);
      const offset = Math.max(0, args.offset ?? 0);
      const limit = Math.max(1, Math.min(args.limit ?? ctx.config.readMaxBytes, ctx.config.readMaxBytes));
      handle = await open(filePath, "r");
      const buffer = Buffer.alloc(Math.max(0, Math.min(limit, fileStat.size - offset)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      const { start, end } = alignUtf8Slice(buffer, bytesRead);
      const sliced = buffer.toString("utf8", start, end);

      return {
        ok: true,
        content: sliced,
        meta: {
          path: filePath,
          offset,
          limit,
          truncated: offset + bytesRead < fileStat.size || start > 0 || end < bytesRead,
          size: fileStat.size,
        },
      };
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : "Failed to read file",
        error: toRuntimeErrorShape(error, "FILE_NOT_FOUND"),
      };
    } finally {
      await handle?.close();
    }
  },
};
