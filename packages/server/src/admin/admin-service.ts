import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AuditService } from "../audit/audit-service.js";
import type { UserStore } from "../auth/user-store.js";
import type { DataPaths } from "../data/paths.js";
import { AppError } from "../domain/identity.js";
import type { Clearance, Identity, Role } from "../domain/types.js";
import type { ModelConfig } from "../model/model-config.js";

/**
 * 管理后台服务（M5，breadth-first 骨架做实）：Skill 列表/启停/自检、模型自检
 * （doctor，脱敏）、用户最简（config/users.json，预置三角色）、提示词内置基线只读。
 */

export interface SkillInfo {
  name: string;
  description: string;
  enabled: boolean;
  /** 自检：SKILL.md 可解析、含 name。 */
  healthy: boolean;
}

export interface ModelDoctor {
  configured: boolean;
  provider: string;
  model: string;
  host: string;
  /** host 是否在 OfflineGuard 白名单（出站会被放行）。 */
  allowlisted: boolean;
}

export interface UserInfo {
  id: string;
  name: string;
  role: Role;
  clearance: Clearance;
  enabled: boolean;
}

export interface PromptInfo {
  id: string;
  name: string;
  role: string;
  description: string;
}

const BUILTIN_PROMPTS: PromptInfo[] = [
  { id: "inquiry.system", name: "问答系统基座（溯源约束）", role: "system", description: "只依据检索片段作答、每条结论须引用 chunk_id、无支撑则拒答（§7.3）。" },
  { id: "report.format", name: "公文通报排版", role: "report", description: "intel-bulletin render_report.py 的公文结构（标题/密级/分节/落款）。" },
];

function skillsDir(): string {
  if (process.env.WORKBENCH_SKILLS_DIR) return process.env.WORKBENCH_SKILLS_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/server/{src,dist}/admin -> repo root
  return path.resolve(here, "..", "..", "..", "..", ".agents", "skills");
}

/** 极简 frontmatter 取值（仅取 name / description 单行字段）。 */
function frontmatterField(md: string, field: string): string {
  const m = md.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return m ? m[1].trim() : "";
}

export class AdminService {
  constructor(
    private readonly paths: DataPaths,
    private readonly audit: AuditService,
    private readonly model: ModelConfig,
    private readonly egressAllowlist: readonly string[],
    private readonly users: UserStore,
  ) {}

  async listSkills(): Promise<SkillInfo[]> {
    const dir = skillsDir();
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const overrides = await this.readSkillOverrides();
    const skills: SkillInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let md = "";
      try {
        md = await readFile(path.join(dir, entry.name, "SKILL.md"), "utf8");
      } catch {
        continue; // 没有 SKILL.md 不算技能
      }
      const name = frontmatterField(md, "name") || entry.name;
      skills.push({
        name,
        description: frontmatterField(md, "description"),
        enabled: overrides[name] ?? true,
        healthy: Boolean(frontmatterField(md, "name")),
      });
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  async setSkillEnabled(actor: Identity, name: string, enabled: boolean): Promise<SkillInfo[]> {
    const overrides = await this.readSkillOverrides();
    overrides[name] = enabled;
    await this.writeJson(this.skillsConfigPath(), overrides);
    await this.audit.append({
      user: actor.id,
      action: "config.skill",
      object: `skill:${name}`,
      detail: { name, enabled },
    });
    return this.listSkills();
  }

  /** 模型自检（脱敏）：不发起网络调用，仅报告配置与白名单状态。 */
  modelDoctor(): ModelDoctor {
    return {
      configured: this.model.configured,
      provider: this.model.provider,
      model: this.model.model,
      host: this.model.host,
      allowlisted: Boolean(this.model.host) && this.egressAllowlist.includes(this.model.host),
    };
  }

  async listUsers(): Promise<UserInfo[]> {
    return this.users.list();
  }

  async createUser(
    actor: Identity,
    input: { id: string; name: string; role: Role; clearance: Clearance; password: string },
  ): Promise<UserInfo> {
    const user = await this.users.create(input);
    await this.audit.append({
      user: actor.id,
      action: "user.create",
      object: `user:${user.id}`,
      detail: { role: user.role, clearance: user.clearance },
    });
    return user;
  }

  async updateUser(
    actor: Identity,
    id: string,
    patch: { name?: string; role?: Role; clearance?: Clearance; enabled?: boolean },
  ): Promise<UserInfo> {
    // 防自锁：不允许管理员停用或改变自己当前登录账号的角色。
    if (id === actor.id && (patch.enabled === false || (patch.role !== undefined && patch.role !== actor.role))) {
      throw new AppError(400, "不能停用或改变当前登录账号的角色");
    }
    const user = await this.users.update(id, patch);
    await this.audit.append({ user: actor.id, action: "user.update", object: `user:${id}`, detail: patch });
    return user;
  }

  async resetPassword(actor: Identity, id: string, password: string): Promise<void> {
    await this.users.setPassword(id, password);
    await this.audit.append({ user: actor.id, action: "user.password", object: `user:${id}` });
  }

  listPrompts(): PromptInfo[] {
    return BUILTIN_PROMPTS;
  }

  // ---- 内部存储 ----

  private skillsConfigPath(): string {
    return path.join(this.paths.configDir, "skills.json");
  }

  private async readSkillOverrides(): Promise<Record<string, boolean>> {
    try {
      return JSON.parse(await readFile(this.skillsConfigPath(), "utf8")) as Record<string, boolean>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
}
