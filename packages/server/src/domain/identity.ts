import type { Request, Response, NextFunction } from "express";

import type { AuthService } from "../auth/auth-service.js";
import type { Identity } from "./types.js";

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

/** 从 `Authorization: Bearer <token>` 取令牌。 */
export function bearerToken(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(Array.isArray(h) ? h[0] : h);
  return m ? m[1].trim() : undefined;
}

/** 无需会话即可访问的路由（相对 `/api` 挂载点）。 */
const PUBLIC_PATHS = new Set(["/health", "/_routes", "/auth/login"]);

/**
 * 鉴权中间件（产品 spec §8.1）。身份**仅**来自服务端会话：从
 * `Authorization: Bearer <token>` 解析令牌 → AuthService 校验 → 注入
 * `req.identity`。无效或缺失令牌的受保护路由返回 401。客户端不再能自报身份
 * （替换 M1 的开发期请求头信任，闭合越权伪冒缺口）。
 */
export function authMiddleware(auth: AuthService) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (PUBLIC_PATHS.has(req.path)) {
      next();
      return;
    }
    const identity = auth.resolve(bearerToken(req));
    if (!identity) {
      next(new AppError(401, "未登录或会话已失效"));
      return;
    }
    req.identity = identity;
    next();
  };
}
