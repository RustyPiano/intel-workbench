import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import type { Role, SessionUser } from "../types";

/**
 * Client-side session state for M0.
 *
 * There is NO real auth in M0 — the login screen just lets you pick a role and
 * we keep the chosen identity in React state (also mirrored to sessionStorage
 * so a refresh during dev doesn't bounce you to /login). M1 replaces this with
 * `POST /api/auth/login` against the local server.
 */

interface SessionContextValue {
  user: SessionUser | null;
  signIn: (user: SessionUser) => void;
  signOut: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const STORAGE_KEY = "intel-workbench.session.v0";

function loadInitial(): SessionUser | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(loadInitial);

  const value = useMemo<SessionContextValue>(
    () => ({
      user,
      signIn: (next) => {
        setUser(next);
        try {
          sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          /* sessionStorage unavailable — keep in-memory only */
        }
      },
      signOut: () => {
        setUser(null);
        try {
          sessionStorage.removeItem(STORAGE_KEY);
        } catch {
          /* ignore */
        }
      },
    }),
    [user],
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
