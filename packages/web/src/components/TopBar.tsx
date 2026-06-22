import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useSession } from "../state/session";
import { CLEARANCE_LABELS, ROLE_LABELS, type Clearance } from "../types";

/**
 * 常驻顶栏（产品 spec §7）：
 * Redesigned with premium CSS and inline SVGs.
 */

const CLEARANCE_TONE: Record<Clearance, string> = {
  internal: "tone-internal",
  secret: "tone-secret",
  confidential: "tone-confidential",
  topsecret: "tone-topsecret",
};

export function TopBar({ breadcrumb }: { breadcrumb?: string }) {
  const { user, signOut } = useSession();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const clearance = user?.clearance ?? "internal";

  return (
    <header className="topbar">
      <div className="topbar__left">
        <Link to="/" className="topbar__brand">
          情报分析工作台
        </Link>
        {breadcrumb ? (
          <>
            <span className="topbar__sep">/</span>
            <span className="topbar__crumb">{breadcrumb}</span>
          </>
        ) : null}
      </div>

      <div className="topbar__right">
        <span className={`badge badge--clearance ${CLEARANCE_TONE[clearance]}`}>
          密级：{CLEARANCE_LABELS[clearance]}
        </span>
        <span className="badge badge--offline" title="应用层出站经 OfflineGuard 白名单授权并审计；离线部署可置空白名单。">
          离线
        </span>
        <span className="badge badge--devmode" title="开发模式：未接入正式开源模型链路，禁止涉密专题">
          开发模式
        </span>

        {user?.role === "admin" ? (
          <Link to="/admin/prompts" className="topbar__admin-entry" style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            管理后台
          </Link>
        ) : null}

        <div className="topbar__user">
          <button
            type="button"
            className="topbar__user-btn"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            style={{ display: "flex", alignItems: "center", gap: "6px" }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
            </svg>
            <span>{user ? `${user.name}（${ROLE_LABELS[user.role]}）` : "未登录"}</span>
            <svg className="icon-svg" style={{ width: "10px", height: "10px", opacity: 0.7 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          {menuOpen ? (
            <div className="topbar__menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  signOut();
                  navigate("/login");
                }}
                style={{ display: "flex", alignItems: "center", gap: "8px" }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                  <polyline points="16 17 21 12 16 7"/>
                  <line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
                退出登录
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
