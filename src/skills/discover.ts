import { access, open } from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";

import { parseSkillMetadata } from "./parse-skill.js";
import type { DiscoveryResult, SkillMeta } from "./types.js";

export interface DiscoverSkillsOptions {
  workspaceRoot: string;
  explicitSkillDirs: string[];
  globalSkillDirs: string[];
}

interface Candidate {
  meta: SkillMeta;
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

const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u;

async function readSkillFrontmatter(skillFile: string): Promise<string> {
  const handle = await open(skillFile, "r");
  const buffer = Buffer.alloc(1024);
  let position = 0;
  let collected = "";

  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        break;
      }

      position += bytesRead;
      collected += buffer.toString("utf8", 0, bytesRead);
      const match = collected.match(FRONTMATTER_PATTERN);
      if (match?.[0]) {
        return match[0];
      }
    }
  } finally {
    await handle.close();
  }

  return collected;
}

export async function readSkillResources(rootDir: string) {
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
      const frontmatter = await readSkillFrontmatter(skillFile);
      const meta = parseSkillMetadata(frontmatter, rootDir, skillFile);

      const priority: [number, number] = [commonPrefixScore(workspaceRoot, rootDir), sourceDir.sourceIndex];
      const existing = selected.get(meta.name);

      if (!existing || priority[0] > existing.priority[0] || (priority[0] === existing.priority[0] && priority[1] >= existing.priority[1])) {
        if (existing) {
          warnings.push(`Skill conflict for ${meta.name}: ${rootDir}`);
        }

        selected.set(meta.name, { meta, priority });
      }
    }
  }

  const records = new Map<string, SkillMeta>();
  const catalog = [...selected.values()]
    .map(({ meta }) => {
      records.set(meta.name, meta);
      return meta;
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    catalog,
    warnings,
    records,
    skillRoots: catalog.map((meta) => meta.rootDir),
  };
}
