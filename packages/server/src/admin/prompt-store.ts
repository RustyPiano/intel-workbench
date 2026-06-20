import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AuditService } from "../audit/audit-service.js";
import { assertSafeId, type DataPaths } from "../data/paths.js";
import { AppError } from "../domain/identity.js";
import type { Identity } from "../domain/types.js";

export const REGISTERED_PROMPTS = [
  {
    id: "inquiry-methodology",
    name: "问答 Agent 方法论",
    role: "system",
    description: "写入 inquiry agent 工作区 AGENTS.md 的溯源方法论。",
    defaultBody: [
      "你是情报分析助手。只依据本专题检索到并引用的素材片段作答，不得使用片段之外的知识。",
      "流程：search_chunks 检索→read_chunk 读全文→对每条结论 cite(chunk_id,claim) 接地（仅哈希校验通过的引用有效）→最后调一次 finalize_answer 提交所有 claims 及其 cite_ids。",
      "材料不足就如实说明，不要编造。",
    ].join("\n"),
  },
  {
    id: "inquiry-structured",
    name: "问答结构化生成",
    role: "system",
    description: "单发问答 generateJson 的 JSON 结构化提示词。",
    defaultBody: [
      "你是情报分析助手。只能依据下方带编号的素材片段回答，不得使用片段之外的任何知识或常识。",
      "每条结论必须在 citations 中引用支撑它的片段编号（chunk_id）。",
      "若给定片段不足以支撑任何结论，置 insufficient=true。",
      "只输出 JSON，不要任何额外文字。schema：",
      '{"claims":[{"text":"结论文本","type":"fact|inference","citations":["chunk_id"]}],"insufficient":false}',
    ].join("\n"),
  },
  {
    id: "element-extract",
    name: "情报要素抽取",
    role: "system",
    description: "要素抽取 generateJson 的实体抽取提示词。",
    defaultBody: [
      "你是情报分析助手。只能依据下方带编号的素材片段，抽取其中明确出现的情报要素（实体）。",
      "要素类型仅限：person(人物) org(组织/机构) location(地点) event(事件) equipment(装备) time(时间)。",
      "每个要素必须在 mentions 中给出支撑它的片段编号 chunk_id（必须来自给定片段）。",
      "不得臆造给定片段之外的要素。只输出 JSON，不要任何额外文字。schema：",
      '{"elements":[{"name":"名称","type":"person|org|location|event|equipment|time","aliases":["别名"],"mentions":[{"chunk_id":"<chunk_id>"}]}]}',
    ].join("\n"),
  },
  {
    id: "contradiction-extract",
    name: "矛盾检测声明抽取",
    role: "system",
    description: "矛盾检测第一步：从素材片段中抽取原子事实性声明。",
    defaultBody: [
      "你是一名情报分析员，负责从情报文本中提取原子事实性声明。",
      "只能依据用户提供的 chunk 内容抽取，不得捏造事实，不得输出给定片段之外的信息。",
      "请仅输出JSON，格式为 {\"claims\":[{\"entity\":\"实体\",\"attribute\":\"属性\",\"value\":\"取值\",\"chunk_id\":\"<chunk_id>\"}]}。",
    ].join("\n"),
  },
  {
    id: "contradiction-judge",
    name: "矛盾检测声明判定",
    role: "system",
    description: "矛盾检测第三步：判断同实体同属性声明之间的关系。",
    defaultBody: [
      "你是一名情报分析员，负责判断两条声明是否矛盾。",
      "只判断用户提供的 claim_a 和 claim_b，不得引入外部知识。",
      "请仅输出JSON，格式为 {\"relation\":\"contradiction|agreement|unrelated\",\"rationale\":\"理由\",\"certainty\":0.0}。",
      "relation只能是 contradiction、agreement 或 unrelated；certainty范围[0,1]。",
    ].join("\n"),
  },
  {
    id: "query-rewrite",
    name: "检索问题改写",
    role: "system",
    description: "把用户问题改写为更适合全文检索的查询。",
    defaultBody: "把用户的检索问题改写成一个更利于全文检索的查询：补全省略的主体、展开同义/相关术语、去除口语和指代，只输出改写后的查询本身，不要解释。",
  },
  {
    id: "query-hyde",
    name: "检索 HyDE 生成",
    role: "system",
    description: "为用户问题生成假设性理想答案段落，用于向量检索。",
    defaultBody: '针对用户的问题，写一段简短的、假设性的"理想答案"段落（2-3 句，情报简报口吻），用于向量检索。只输出该段落，不要前后缀。',
  },
  {
    id: "chunk-context",
    name: "切块检索语境",
    role: "system",
    description: "Contextual Retrieval 的单片段全文定位提示词。",
    defaultBody: "给定整篇文档与其中一个片段，用一句话写出该片段在全文中的定位/情境（便于检索），只输出这句话、不复述原文、不解释。",
  },
] as const;

export type ManagedPromptId = (typeof REGISTERED_PROMPTS)[number]["id"];

export const DEFAULT_PROMPT_BODIES = Object.fromEntries(
  REGISTERED_PROMPTS.map((prompt) => [prompt.id, prompt.defaultBody]),
) as Record<ManagedPromptId, string>;

export interface ManagedPromptInfo {
  id: ManagedPromptId;
  name: string;
  role: string;
  description: string;
  edited: boolean;
  version: number;
  healthy: boolean;
  updatedAt?: string;
}

export interface PromptVersionInfo {
  ts: string;
  bytes: number;
}

export interface ManagedPromptDetail {
  id: ManagedPromptId;
  name: string;
  role: string;
  description: string;
  body: string;
  isDefault: boolean;
  version: number;
  healthy: boolean;
  updatedAt?: string;
  versions: PromptVersionInfo[];
}

type RegisteredPrompt = (typeof REGISTERED_PROMPTS)[number];

const PROMPT_BY_ID = new Map<ManagedPromptId, RegisteredPrompt>(
  REGISTERED_PROMPTS.map((prompt) => [prompt.id, prompt]),
);

export class PromptStore {
  constructor(
    private readonly paths: DataPaths,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<ManagedPromptInfo[]> {
    const prompts: ManagedPromptInfo[] = [];
    for (const prompt of REGISTERED_PROMPTS) {
      const current = this.currentPath(prompt.id);
      const currentStat = await this.tryStat(current);
      const edited = currentStat !== null;
      const body = edited ? await readFile(current, "utf8") : prompt.defaultBody;
      const versions = await this.listVersions(prompt.id);
      prompts.push({
        id: prompt.id,
        name: prompt.name,
        role: prompt.role,
        description: prompt.description,
        edited,
        version: versions.length + (edited ? 1 : 0),
        healthy: body.trim().length > 0,
        updatedAt: currentStat?.mtime.toISOString(),
      });
    }
    return prompts;
  }

  async getBody(id: string): Promise<string> {
    const prompt = this.registered(id);
    try {
      return await readFile(this.currentPath(prompt.id), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return prompt.defaultBody;
      throw e;
    }
  }

  async getDetail(id: string): Promise<ManagedPromptDetail> {
    const prompt = this.registered(id);
    const current = this.currentPath(prompt.id);
    const currentStat = await this.tryStat(current);
    const body = currentStat ? await readFile(current, "utf8") : prompt.defaultBody;
    const versions = await this.listVersions(prompt.id);
    return {
      id: prompt.id,
      name: prompt.name,
      role: prompt.role,
      description: prompt.description,
      body,
      isDefault: currentStat === null,
      version: versions.length + (currentStat ? 1 : 0),
      healthy: body.trim().length > 0,
      updatedAt: currentStat?.mtime.toISOString(),
      versions,
    };
  }

  async update(actor: Identity, id: string, body: string): Promise<void> {
    const prompt = this.registered(id);
    // 空提示词会让系统提示形同虚设（非技术管理员易误操作）——直接拒绝。
    if (body.trim().length === 0) throw new AppError(400, "提示词内容不能为空");
    const previous = await this.getBody(prompt.id);
    const versionDir = this.versionDir(prompt.id);
    await mkdir(versionDir, { recursive: true });
    // 归档旧版：独占创建（flag "wx"）+ 时间戳递增重试，避免同毫秒并发编辑互相覆盖历史。
    let ms = Date.now();
    for (;;) {
      try {
        await writeFile(path.join(versionDir, `${new Date(ms).toISOString()}.md`), previous, { encoding: "utf8", flag: "wx" });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          ms += 1;
          continue;
        }
        throw e;
      }
    }

    await mkdir(this.promptsDir(), { recursive: true });
    await writeFile(this.currentPath(prompt.id), body, "utf8");
    await this.audit.append({
      user: actor.id,
      action: "prompt.update",
      object: `prompt:${prompt.id}`,
      detail: { id: prompt.id, bytes: body.length },
    });
  }

  async listVersions(id: string): Promise<PromptVersionInfo[]> {
    const prompt = this.registered(id);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.versionDir(prompt.id), { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const versions: PromptVersionInfo[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const ts = entry.name.slice(0, -".md".length);
      const file = path.join(this.versionDir(prompt.id), entry.name);
      versions.push({ ts, bytes: (await stat(file)).size });
    }
    return versions.sort((a, b) => a.ts.localeCompare(b.ts));
  }

  async getVersion(id: string, ts: string): Promise<string> {
    const prompt = this.registered(id);
    assertSafeId(ts);
    try {
      return await readFile(path.join(this.versionDir(prompt.id), `${ts}.md`), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "提示词版本不存在");
      throw e;
    }
  }

  private registered(id: string): RegisteredPrompt {
    const prompt = PROMPT_BY_ID.get(id as ManagedPromptId);
    if (!prompt) throw new AppError(404, "提示词不存在");
    return prompt;
  }

  private promptsDir(): string {
    return path.join(this.paths.configDir, "prompts");
  }

  private currentPath(id: ManagedPromptId): string {
    return path.join(this.promptsDir(), `${assertSafeId(id)}.md`);
  }

  private versionDir(id: ManagedPromptId): string {
    return path.join(this.promptsDir(), `${assertSafeId(id)}.versions`);
  }

  private async tryStat(file: string): Promise<import("node:fs").Stats | null> {
    try {
      return await stat(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

}
