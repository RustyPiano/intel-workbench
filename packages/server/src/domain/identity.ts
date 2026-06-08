import type { Request, Response, NextFunction } from "express";

import { CLEARANCES, ROLES, type Clearance, type Identity, type Role } from "./types.js";

/** 业务错误：携带 HTTP 状态码，由全局错误处理中间件转 JSON。 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      identity: Identity;
    }
  }
}

/**
 * 开发期身份（M1）。**真正的登录 / 会话 / 口令校验在 M5 落地**
 * （`config/users.json`）。现阶段服务端信任前端 role-picker 选定的身份，
 * 经请求头注入（仅 ASCII：id / role / clearance），并对取值做白名单兜底。
 * 审计的 `user` 即此处的 `id`。
 */
const DEV_DEFAULT: Identity = {
  id: "dev-operator",
  name: "演示作业员",
  role: "operator",
  clearance: "internal",
};

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function header(req: Request, key: string): string | undefined {
  const v = req.headers[key];
  return Array.isArray(v) ? v[0] : v;
}

export function identityMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const role = pick<Role>(header(req, "x-user-role"), ROLES, DEV_DEFAULT.role);
  const clearance = pick<Clearance>(header(req, "x-user-clearance"), CLEARANCES, DEV_DEFAULT.clearance);
  const id = header(req, "x-user-id") || DEV_DEFAULT.id;
  req.identity = { id, name: id, role, clearance };
  next();
}
