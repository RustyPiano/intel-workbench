import { Router } from "express";

import type { AuditService } from "../audit/audit-service.js";
import { AppError } from "../domain/identity.js";
import type { Identity } from "../domain/types.js";

/**
 * 审计 REST 路由（工程方案 §5 / §7.2，M1 做实：列表 + verify）。
 * 导出留存（`/export`）属 M5，留 stub。
 */
export function createAuditRouter(audit: AuditService): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    assertAuditor(req.identity);
    res.json({ ok: true, events: await audit.readAll() });
  });

  router.get("/verify", async (req, res) => {
    assertAuditor(req.identity);
    res.json({ ok: true, result: await audit.verify() });
  });

  return router;
}

/** 审计中心面向保密员与管理员（产品 spec §8.15）；作业员无权查全量审计。 */
function assertAuditor(actor: Identity): void {
  if (actor.role !== "security" && actor.role !== "admin") {
    throw new AppError(403, "仅保密员或管理员可查看审计");
  }
}
