import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import { AppError } from "../domain/identity.js";
import type { Identity } from "../domain/types.js";

export class ReviewService {
  constructor(private readonly cases: CaseService, private readonly audit: AuditService) {}

  /** 标记一条低置信项为"已人工校对"（§9.2）。审计日志即唯一存储；先校验访问。 */
  async mark(actor: Identity, caseId: string, ref: string): Promise<void> {
    await this.cases.get(actor, caseId); // 访问/密级校验（无权抛 AppError）
    const trimmed = ref.trim();
    if (!trimmed || trimmed.length > 200) throw new AppError(400, "校对引用无效");
    await this.audit.append({ user: actor.id, action: "review.mark", object: `case:${caseId}`, caseId, detail: { ref: trimmed } });
  }
}
