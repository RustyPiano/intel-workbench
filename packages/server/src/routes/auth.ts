import { Router } from "express";

import type { AuthService } from "../auth/auth-service.js";
import { AppError, bearerToken } from "../domain/identity.js";

/**
 * 鉴权路由（产品 spec §8.1）。`/login` 公开；`/me`、`/logout` 需有效会话
 * （由 authMiddleware 注入 `req.identity`）。
 */
export function createAuthRouter(auth: AuthService): Router {
  const router = Router();

  router.post("/login", async (req, res) => {
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof username !== "string" || typeof password !== "string") {
      throw new AppError(400, "缺少用户名或口令");
    }
    const { token, identity } = await auth.login(username, password);
    res.json({ ok: true, token, user: identity });
  });

  router.get("/me", (req, res) => {
    res.json({ ok: true, user: req.identity });
  });

  router.post("/logout", async (req, res) => {
    await auth.logout(bearerToken(req), req.identity);
    res.json({ ok: true });
  });

  return router;
}
