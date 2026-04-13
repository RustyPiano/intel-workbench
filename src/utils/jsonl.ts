import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

export async function writeJsonlLine(filePath: string, value: unknown, overwrite = false): Promise<void> {
  await ensureParentDir(filePath);
  const serialized = `${JSON.stringify(value)}\n`;

  if (overwrite) {
    await writeFile(filePath, serialized, "utf8");
    return;
  }

  await appendFile(filePath, serialized, "utf8");
}

export async function readJsonlFile(filePath: string): Promise<string[]> {
  const content = await readFile(filePath, "utf8");
  return content.split("\n").filter(Boolean);
}
