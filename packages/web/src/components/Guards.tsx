import { Navigate, useLocation } from "react-router-dom";

import { useSession } from "../state/session";
import type { Role } from "../types";
import type { ReactNode } from "react";

/** Redirect to /login if no session. */
export function RequireSession({ children }: { children: ReactNode }) {
  const { user, loading } = useSession();
  const location = useLocation();
  if (loading) return null; // 会话恢复中，先不渲染，避免误跳登录页
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

/**
 * Gate a subtree to specific roles. Used so the 管理后台 face is only reachable
 * by 管理员, and the 审计中心 by 保密员/管理员 (产品 spec §3).
 */
export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user, loading } = useSession();
  if (loading) return null;
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (!roles.includes(user.role)) {
    // No access for this role — bounce to a face they can use, not an error.
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
