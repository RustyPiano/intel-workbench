import { open, stat } from "node:fs/promises";
import { z } from "zod";

import { toRuntimeErrorShape } from "../runtime/errors.js";
import type { RuntimeTool } from "./types.js";

const readArgsSchema = z
  .object({
    path: z.string(),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("1-based line number to start reading from. Defaults to line 1."),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Maximum number of lines to read. Defaults to 2000."),
  })
  .strict();

type ReadArgs = z.infer<typeof readArgsSchema>;

interface ReadData {
  path: string;
  /** 1-based line number of the first returned line. */
  offset: number;
  /** Line limit applied to this read. */
  limit: number;
  /** Number of lines returned. */
  lines: number;
  truncated: boolean;
  /** File size in bytes. */
  size: number;
}

/** Default number of lines returned when `limit` is omitted (mirrors Claude Code's Read). */
const DEFAULT_READ_LINES = 2000;
/** Per-line character cap; longer lines are truncated so one giant line cannot flood context. */
const MAX_LINE_LENGTH = 2000;
/** Width of the right-aligned line-number gutter in the `cat -n` style output. */
const LINE_NUMBER_WIDTH = 6;

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

/**
 * Return the largest end index <= bytesRead that does not split a multi-byte
 * UTF-8 sequence. The buffer is always read from byte 0 of the file, so the
 * start is guaranteed to sit on a codepoint boundary; only the tail can be
 * truncated mid-sequence by the byte cap.
 */
function utf8SafeEnd(buffer: Buffer, bytesRead: number): number {
  if (bytesRead <= 0) {
    return 0;
  }

  let sequenceStart = bytesRead - 1;
  while (sequenceStart >= 0 && isContinuationByte(buffer[sequenceStart])) {
    sequenceStart -= 1;
  }
  if (sequenceStart < 0) {
    return 0;
  }

  return sequenceStart + utf8SequenceLength(buffer[sequenceStart]) > bytesRead ? sequenceStart : bytesRead;
}

export const readTool: RuntimeTool<ReadArgs, ReadData> = {
  name: "read",
  description:
    "Read a UTF-8 text file within the workspace. `offset`/`limit` count lines (1-based); by default the first 2000 lines are returned. Each line is prefixed with its line number and a tab (`<n>\\t`) in cat -n style — these prefixes are not part of the file, so strip them before reusing text as edit old_text. Do not use this to read .env files, API keys, tokens, or credential files.",
  inputSchema: readArgsSchema,
  async execute(args, ctx) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    try {
      const filePath = ctx.policy.resolveReadPath(args.path);
      const fileStat = await stat(filePath);
      const startLine = Math.max(1, args.offset ?? 1);
      const lineLimit = Math.max(1, args.limit ?? DEFAULT_READ_LINES);
      const maxBytes = Math.max(1, ctx.config.readMaxBytes);

      handle = await open(filePath, "r");
      const bufferSize = Math.min(maxBytes, fileStat.size);
      const buffer = Buffer.alloc(bufferSize);
      const { bytesRead } = await handle.read(buffer, 0, bufferSize, 0);
      const reachedEof = bytesRead >= fileStat.size;

      let text = buffer.toString("utf8", 0, utf8SafeEnd(buffer, bytesRead));

      // If the byte cap stopped us before EOF, the final line is probably
      // incomplete — drop it so we never present half a line as if it were whole.
      if (!reachedEof) {
        const lastNewline = text.lastIndexOf("\n");
        if (lastNewline >= 0) {
          text = text.slice(0, lastNewline + 1);
        }
      }

      // Split into lines, discarding the empty element a trailing newline produces.
      const allLines = text.split("\n");
      if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
        allLines.pop();
      }

      const startIndex = startLine - 1;
      const selected = allLines.slice(startIndex, startIndex + lineLimit);

      let lineTruncated = false;
      const formatted = selected.map((rawLine, index) => {
        let line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line.length > MAX_LINE_LENGTH) {
          line = line.slice(0, MAX_LINE_LENGTH);
          lineTruncated = true;
        }
        return `${String(startLine + index).padStart(LINE_NUMBER_WIDTH)}\t${line}`;
      });

      const moreLinesInWindow = startIndex + lineLimit < allLines.length;
      const truncated = !reachedEof || moreLinesInWindow || lineTruncated;

      return {
        ok: true,
        content: formatted.join("\n"),
        meta: {
          path: filePath,
          offset: startLine,
          limit: lineLimit,
          lines: formatted.length,
          truncated,
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
