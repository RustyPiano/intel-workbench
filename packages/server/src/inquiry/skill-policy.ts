import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "../util/hash.js";

export interface SkillPolicySnapshot {
  /** config/skills.json 中显式 enabled===false 的技能名（向运行时隐藏）。 */
  disabledSkillNames: string[];
  /** skills.json 原文哈希；用于侦测后台启停后作废缓存 agent。文件缺失为 "none"。 */
  revision: string;
}

export function resolveSkillDirs(): string[] {
  if (process.env.WORKBENCH_SKILL_DIRS) {
    return process.env.WORKBENCH_SKILL_DIRS.split(path.delimiter).filter((dir) => dir.length > 0);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/server/{src,dist}/inquiry -> repo root
  return [path.resolve(here, "..", "..", "..", "..", ".agents", "skills")];
}

/**
 * 原子读取技能启停策略：禁用名单与 revision 来自同一次文件读取，杜绝"两次独立读"
 * 被后台写入夹在中间（旧 disabled + 新 revision → 失效检查恒等 → 永不重建）的竞态。
 */
export async function readSkillPolicy(configDir: string): Promise<SkillPolicySnapshot> {
  try {
    const raw = await readFile(path.join(configDir, "skills.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, boolean>;
    const disabledSkillNames = Object.entries(parsed)
      .filter(([, enabled]) => enabled === false)
      .map(([name]) => name);
    return { disabledSkillNames, revision: sha256(raw) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { disabledSkillNames: [], revision: "none" };
    throw e;
  }
}

/** 仅取 revision（单次读，无原子性问题）；供每次 ask 的轻量失效检查。 */
export async function skillPolicyRevision(configDir: string): Promise<string> {
  try {
    const raw = await readFile(path.join(configDir, "skills.json"), "utf8");
    return sha256(raw);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "none";
    throw e;
  }
}
