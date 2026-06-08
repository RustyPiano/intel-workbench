import { Router } from "express";

import type { AdminService } from "../admin/admin-service.js";
import { AppError } from "../domain/identity.js";
import type { Identity } from "../domain/types.js";

/**
 * 管理后台路由（工程方案 §5，M5）。仅管理员可访问。
 */
export function createAdminRouter(admin: AdminService): Router {
  const router = Router();

  router.use((req, _res, next) => {
    assertAdmin(req.identity);
    next();
  });

  router.get("/skills", async (_req, res) => {
    res.json({ ok: true, skills: await admin.listSkills() });
  });

  router.post("/skills/:name", async (req, res) => {
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    const skills = await admin.setSkillEnabled(req.identity, req.params.name, enabled !== false);
    res.json({ ok: true, skills });
  });

  router.get("/models", (_req, res) => {
    res.json({ ok: true, model: admin.modelDoctor() });
  });

  router.get("/users", async (_req, res) => {
    res.json({ ok: true, users: await admin.listUsers() });
  });

  router.get("/prompts", (_req, res) => {
    res.json({ ok: true, prompts: admin.listPrompts() });
  });

  return router;
}

function assertAdmin(actor: Identity): void {
  if (actor.role !== "admin") throw new AppError(403, "仅管理员可访问管理后台");
}
