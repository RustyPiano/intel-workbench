import type { AuditService } from "../audit/audit-service.js";
import { AppError } from "../domain/identity.js";

/**
 * 零外发应用层闸门（工程方案 §7.1）。应用自身的全部出站都必须先经此授权：
 * 仅白名单 host 放行，其余一律拒绝；放行/拒绝都落审计。开发期白名单仅文本
 * LLM 端点；生产把白名单置空即一键全断。
 *
 * 边界诚实：这是**应用级**可验证闸门，不承诺观测 OS/工具级出网——后者由气隙
 * 部署强制（§7.1）。
 */
export class OfflineGuard {
  private readonly allowed: Set<string>;

  constructor(
    allowedHosts: readonly string[],
    private readonly audit: AuditService,
  ) {
    this.allowed = new Set(allowedHosts.filter(Boolean));
  }

  get allowlist(): string[] {
    return [...this.allowed];
  }

  /** 授权一次出站；非白名单 → 落"外发拦截"审计并抛 403。 */
  async authorize(targetUrl: string, ctx: { user: string; purpose: string }): Promise<void> {
    let host = "";
    try {
      host = new URL(targetUrl).host;
    } catch {
      host = targetUrl;
    }
    const allowed = this.allowed.has(host);
    await this.audit.append({
      user: ctx.user,
      action: allowed ? "egress.allow" : "egress.deny",
      object: `egress:${host}`,
      result: allowed ? "ok" : "deny",
      detail: { host, purpose: ctx.purpose },
    });
    if (!allowed) {
      throw new AppError(403, `外发被拦截：目标 ${host} 不在白名单（零外发红线）`);
    }
  }
}
