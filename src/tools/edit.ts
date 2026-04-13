import { readFile, writeFile } from "node:fs/promises";

import { RuntimeError, toRuntimeErrorShape } from "../runtime/errors.js";
import { normalizeForMatching, normalizeNeedle, normalizeTextForEditing } from "./utils/text-normalize.js";
import type { RuntimeTool } from "./types.js";

interface EditArgs {
  path: string;
  old_text: string;
  new_text: string;
  replace_all?: boolean;
}

interface EditData {
  path: string;
  replacements: number;
}

function findOccurrences(haystack: string, needle: string): number[] {
  if (!needle) {
    return [];
  }

  const matches: number[] = [];
  let cursor = 0;

  while (cursor <= haystack.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index === -1) {
      break;
    }

    matches.push(index);
    cursor = index + needle.length;
  }

  return matches;
}

export const editTool: RuntimeTool<EditArgs, EditData> = {
  name: "edit",
  description: "Replace a section of a text file using old_text/new_text matching.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_text: { type: "string" },
      new_text: { type: "string" },
      replace_all: { type: "boolean" },
    },
    required: ["path", "old_text", "new_text"],
  },
  async execute(args, ctx) {
    const queue = ctx.fileMutationQueue;

    if (!queue) {
      throw new Error("editTool requires fileMutationQueue in ToolContext");
    }

    try {
      const filePath = ctx.policy.resolveWritePath(args.path);

      return await queue.runExclusive(filePath, async () => {
        const source = await readFile(filePath, "utf8");
        const workingSource = normalizeTextForEditing(source);
        const normalizedSource = normalizeForMatching(workingSource);
        const normalizedNeedle = normalizeNeedle(args.old_text);
        const matches = findOccurrences(normalizedSource.text, normalizedNeedle);

        if (matches.length === 0) {
          throw new RuntimeError({
            code: "EDIT_NO_MATCH",
            message: `Could not find the requested text in ${args.path}`,
          });
        }

        if (matches.length > 1 && !args.replace_all) {
          throw new RuntimeError({
            code: "EDIT_AMBIGUOUS",
            message: `Found ${matches.length} matches in ${args.path}; set replace_all=true to replace all occurrences`,
          });
        }

        let output = workingSource;
        const replacementTargets = (args.replace_all ? matches : matches.slice(0, 1))
          .map((startIndex) => ({
            start: normalizedSource.indexMap[startIndex] ?? startIndex,
            end: normalizedSource.indexMap[startIndex + normalizedNeedle.length] ?? workingSource.length,
          }))
          .sort((left, right) => right.start - left.start);

        for (const target of replacementTargets) {
          output = `${output.slice(0, target.start)}${args.new_text}${output.slice(target.end)}`;
        }

        output = normalizeTextForEditing(output);
        await writeFile(filePath, output, "utf8");

        return {
          ok: true,
          content: `Edited ${replacementTargets.length} occurrence(s) in ${args.path}`,
          data: {
            path: filePath,
            replacements: replacementTargets.length,
          },
        };
      });
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : "Failed to edit file",
        error: toRuntimeErrorShape(error, "INTERNAL_ERROR"),
      };
    }
  },
};
