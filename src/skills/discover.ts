import { access, readFile } from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";

import { parseSkillFile } from "./parse-skill.js";
import type { DiscoveryResult, SkillRecord } from "./types.js";

export interface DiscoverSkillsOptions {
  workspaceRoot: string;
  explicitSkillDirs: string[];
  globalSkillDirs: string[];
}

interface Candidate {
  record: SkillRecord;
  priority: [number, number];
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function commonPrefixScore(workspaceRoot: string, candidateRoot: string): number {
  const workspaceParts = path.resolve(workspaceRoot).split(path.sep).filter(Boolean);
  const candidateParts = path.resolve(candidateRoot).split(path.sep).filter(Boolean);
  const length = Math.min(workspaceParts.length, candidateParts.length);
  let score = 0;

  for (let index = 0; index < length; index += 1) {
    if (workspaceParts[index] !== candidateParts[index]) {
      break;
    }

    score += 1;
  }

  return score;
}

async function listSkillRoots(skillBaseDir: string): Promise<string[]> {
  if (!(await pathExists(skillBaseDir))) {
    return [];
  }

  return fg(["*/SKILL.md"], {
    cwd: skillBaseDir,
    absolute: true,
    onlyFiles: true,
    suppressErrors: true,
  }).then((files) => files.map((file) => path.dirname(file)).sort());
}

async function readResources(rootDir: string) {
  const scripts = await fg(["scripts/**/*"], {
    cwd: rootDir,
    onlyFiles: true,
    suppressErrors: true,
  });
  const references = await fg(["references/**/*"], {
    cwd: rootDir,
    onlyFiles: true,
    suppressErrors: true,
  });
  const assets = await fg(["assets/**/*"], {
    cwd: rootDir,
    onlyFiles: true,
    suppressErrors: true,
  });

  return {
    scripts: scripts.sort(),
    references: references.sort(),
    assets: assets.sort(),
  };
}

export async function discoverSkills(options: DiscoverSkillsOptions): Promise<DiscoveryResult> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const workspaceSkillDir = path.join(workspaceRoot, ".agents", "skills");
  const sourceDirs = [
    ...options.globalSkillDirs.map((dir, index) => ({
      dir: path.resolve(dir),
      sourceIndex: index,
    })),
    {
      dir: workspaceSkillDir,
      sourceIndex: options.globalSkillDirs.length,
    },
    ...options.explicitSkillDirs.map((dir, index) => ({
      dir: path.resolve(dir),
      sourceIndex: options.globalSkillDirs.length + 1 + index,
    })),
  ];

  const warnings: string[] = [];
  const selected = new Map<string, Candidate>();

  for (const sourceDir of sourceDirs) {
    const roots = await listSkillRoots(sourceDir.dir);

    for (const rootDir of roots) {
      const skillFile = path.join(rootDir, "SKILL.md");
      const rawContent = await readFile(skillFile, "utf8");
      const record = parseSkillFile(rawContent, rootDir, skillFile);
      record.resources = await readResources(rootDir);

      const priority: [number, number] = [commonPrefixScore(workspaceRoot, rootDir), sourceDir.sourceIndex];
      const existing = selected.get(record.meta.name);

      if (!existing || priority[0] > existing.priority[0] || (priority[0] === existing.priority[0] && priority[1] >= existing.priority[1])) {
        if (existing) {
          warnings.push(`Skill conflict for ${record.meta.name}: ${rootDir}`);
        }

        selected.set(record.meta.name, { record, priority });
      }
    }
  }

  const records = new Map<string, SkillRecord>();
  const catalog = [...selected.values()]
    .map(({ record }) => {
      records.set(record.meta.name, record);
      return record.meta;
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    catalog,
    warnings,
    records,
    skillRoots: catalog.map((meta) => meta.rootDir),
  };
}
