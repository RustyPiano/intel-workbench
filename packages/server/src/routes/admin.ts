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

  router.post("/users", async (req, res) => {
    const { id, name, role, clearance, password } = (req.body ?? {}) as Record<string, string>;
    const user = await admin.createUser(req.identity, {
      id: id ?? "",
      name: name ?? "",
      role: role as Identity["role"],
      clearance: clearance as Identity["clearance"],
      password: password ?? "",
    });
    res.status(201).json({ ok: true, user });
  });

  router.patch("/users/:id", async (req, res) => {
    const user = await admin.updateUser(req.identity, req.params.id, (req.body ?? {}) as Parameters<AdminService["updateUser"]>[2]);
    res.json({ ok: true, user });
  });

  router.post("/users/:id/password", async (req, res) => {
    const { password } = (req.body ?? {}) as { password?: string };
    await admin.resetPassword(req.identity, req.params.id, password ?? "");
    res.json({ ok: true });
  });

  router.get("/prompts", async (_req, res) => {
    res.json({ ok: true, prompts: await admin.listPrompts() });
  });

  router.get("/prompts/:id", async (req, res) => {
    res.json({ ok: true, prompt: await admin.getPrompt(req.params.id) });
  });

  router.put("/prompts/:id", async (req, res) => {
    const { body } = (req.body ?? {}) as { body?: unknown };
    if (typeof body !== "string") throw new AppError(400, "提示词正文不能为空");
    await admin.updatePrompt(req.identity, req.params.id, body);
    res.json({ ok: true, prompt: await admin.getPrompt(req.params.id) });
  });

  router.get("/prompts/:id/versions", async (req, res) => {
    res.json({ ok: true, versions: await admin.listPromptVersions(req.params.id) });
  });

  router.get("/prompts/:id/versions/:ts", async (req, res) => {
    res.json({ ok: true, body: await admin.getPromptVersion(req.params.id, req.params.ts) });
  });

  return router;
}

function assertAdmin(actor: Identity): void {
  if (actor.role !== "admin") throw new AppError(403, "仅管理员可访问管理后台");
}
