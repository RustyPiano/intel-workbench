import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { fetchMe, login as apiLogin, logout as apiLogout, setSessionToken } from "../api";
import type { Role, SessionUser } from "../types";

/**
 * 客户端会话状态。身份由服务端会话决定：登录（`POST /api/auth/login`）拿到
 * 令牌后存入 sessionStorage 并注入 API 客户端；刷新时凭存储令牌向 `/auth/me`
 * 校验恢复，失效即清理并回登录页。
 */

interface SessionContextValue {
  user: SessionUser | null;
  /** 启动期凭存储令牌恢复会话中——守卫据此避免误跳登录页。 */
  loading: boolean;
  signIn: (username: string, password: string) => Promise<SessionUser>;
  signOut: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const TOKEN_KEY = "intel-workbench.token.v1";

function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function persistToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* sessionStorage 不可用 — 仅内存态 */
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  // 启动恢复：有存储令牌则向服务端校验，失效则清理。
  useEffect(() => {
    const token = readToken();
    if (!token) {
      setLoading(false);
      return;
    }
    setSessionToken(token);
    let alive = true;
    fetchMe()
      .then((u) => {
        if (alive) setUser(u);
      })
      .catch(() => {
        if (!alive) return;
        setSessionToken(null);
        persistToken(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      user,
      loading,
      signIn: async (username, password) => {
        const { token, user: signedIn } = await apiLogin(username, password);
        setSessionToken(token);
        persistToken(token);
        setUser(signedIn);
        return signedIn;
      },
      signOut: () => {
        void apiLogout();
        setSessionToken(null);
        persistToken(null);
        setUser(null);
      },
    }),
    [user, loading],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSession 必须在 <SessionProvider> 内使用");
  }
  return ctx;
}

/** 角色登陆后的默认落地路由（产品 spec §8.1）。 */
export function landingPathForRole(role: Role): string {
  switch (role) {
    case "security":
      return "/audit"; // 保密员 → 审计中心
    case "admin":
      return "/"; // 管理员 → 首页（顶栏可见管理后台入口）
    case "operator":
    default:
      return "/"; // 作业员 → 首页/专题列表
  }
}
