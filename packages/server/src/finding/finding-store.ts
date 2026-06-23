import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { FileMutationQueue } from "mini-agent";

import type { DataPaths } from "../data/paths.js";
import type { ContradictionAcknowledgement, Finding } from "../domain/types.js";
import { writeFileAtomic } from "../util/atomic.js";

const FINDINGS_FILE = "findings.json";
const CONTRADICTION_ACKS_FILE = "contradiction-acks.json";
const queue = new FileMutationQueue();

export function findingsFilePath(paths: DataPaths, caseId: string): string {
  return path.join(paths.caseDir(caseId), FINDINGS_FILE);
}

export function contradictionAcksFilePath(paths: DataPaths, caseId: string): string {
  return path.join(paths.caseDir(caseId), CONTRADICTION_ACKS_FILE);
}

export async function readFindings(paths: DataPaths, caseId: string): Promise<Finding[]> {
  const parsed = await readJson<Finding[]>(findingsFilePath(paths, caseId));
  return Array.isArray(parsed) ? parsed : [];
}

export async function replaceFindings(paths: DataPaths, caseId: string, findings: Finding[]): Promise<void> {
  const file = findingsFilePath(paths, caseId);
  await queue.runExclusive(file, async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(findings, null, 2)}\n`);
  });
}

export async function readContradictionAcknowledgements(paths: DataPaths, caseId: string): Promise<ContradictionAcknowledgement[]> {
  const parsed = await readJson<ContradictionAcknowledgement[]>(contradictionAcksFilePath(paths, caseId));
  return Array.isArray(parsed) ? parsed : [];
}

export async function saveContradictionAcknowledgement(paths: DataPaths, acknowledgement: ContradictionAcknowledgement): Promise<void> {
  const file = contradictionAcksFilePath(paths, acknowledgement.case_id);
  await queue.runExclusive(file, async () => {
    const acknowledgements = await readContradictionAcknowledgements(paths, acknowledgement.case_id);
    const index = acknowledgements.findIndex((ack) => ack.contradiction_id === acknowledgement.contradiction_id);
    if (index >= 0) acknowledgements[index] = acknowledgement;
    else acknowledgements.push(acknowledgement);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(acknowledgements, null, 2)}\n`);
  });
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
