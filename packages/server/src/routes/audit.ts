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

  // 导出留存（M5）：导出动作本身入审计（§5）。
  router.post("/export", async (req, res) => {
    assertAuditor(req.identity);
    const events = await audit.readAll();
    await audit.append({ user: req.identity.id, action: "audit.export", object: "audit:all", detail: { count: events.length } });
    res.json({ ok: true, exportedAt: new Date().toISOString(), count: events.length, events });
  });

  return router;
}

/** 审计中心面向保密员与管理员（产品 spec §8.15）；作业员无权查全量审计。 */
function assertAuditor(actor: Identity): void {
  if (actor.role !== "security" && actor.role !== "admin") {
    throw new AppError(403, "仅保密员或管理员可查看审计");
  }
}
