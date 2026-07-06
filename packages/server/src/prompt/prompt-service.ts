import type { ManagedPromptId, PromptStore } from "../admin/prompt-store.js";
import type { AuditService } from "../audit/audit-service.js";
import type { Identity } from "../domain/types.js";

export type { ManagedPromptId } from "../admin/prompt-store.js";

/**
 * 提示词服务（智能工作流自动化决策文档 §阶段 2.2）。在既有 `PromptStore`（受管提示词
 * 存取 + 版本历史）之上加一层"取用"接口：变量渲染 + 访问审计。不重复 PromptStore 的
 * 存储/版本职责——`getPrompt` 内部委托 `promptStore.getBody`，本服务只负责渲染与审计。
 */
export class PromptService {
  constructor(
    private readonly promptStore: PromptStore,
    private readonly audit: AuditService,
  ) {}

  /**
   * 取用一条受管提示词，可选做变量替换。`actor` 为本服务相对决策文档草案多出的首参——
   * 审计事件必须落到真实用户（此仓库所有 `audit.append` 调用一贯如此），且访问审计本身
   * 就是为了追踪"谁在何时用了哪条提示词"，省略 actor 会使这条审计失去意义。
   */
  async getPrompt(actor: Identity, id: ManagedPromptId, context?: Record<string, unknown>): Promise<string> {
    const template = await this.promptStore.getBody(id);
    const rendered = context ? this.render(template, context) : template;
    await this.audit.append({
      user: actor.id,
      action: "prompt.access",
      object: `prompt:${id}`,
      detail: { id, hasContext: Boolean(context) },
    });
    return rendered;
  }

  /** `{key}` → `String(context[key])`；未提供的变量原样保留（便于发现模板/调用方不匹配）。 */
  private render(template: string, context: Record<string, unknown>): string {
    return template.replace(/\{(\w+)\}/g, (match, key: string) => {
      if (!(key in context)) return match;
      const value = context[key];
      return value === undefined || value === null ? "" : String(value);
    });
  }
}
