import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { TopBar } from "../components/TopBar";

function breadcrumbFor(pathname: string): string {
  if (pathname === "/overview") return "数据总览";
  if (pathname === "/cases/new") return "新建专题";
  if (pathname.startsWith("/cases/")) return "专题工作台";
  return "专题列表";
}

/**
 * 作业面布局（产品 spec §3 双面分离）：作业员的工作台外壳。
 */
export function OperatorLayout() {
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="app-shell">
      <TopBar breadcrumb={breadcrumbFor(pathname)} />
      <div className="app-body">
        <nav className={`side-nav ${collapsed ? "side-nav--collapsed" : ""}`}>
          <div className="side-nav__head">
            <div className="side-nav__group">业务作业</div>
            <button type="button" className="side-nav__toggle" aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"} title={collapsed ? "展开侧边栏" : "折叠侧边栏"} onClick={() => setCollapsed((v) => !v)}>
              <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3.5" y="4.5" width="17" height="15" rx="3"/>
                <line x1="9.5" y1="5" x2="9.5" y2="19"/>
              </svg>
              <span>折叠侧边栏</span>
            </button>
          </div>
          <NavLink to="/" end className="side-nav__link" title="专题列表" aria-label="专题列表">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
              <polyline points="9 22 9 12 15 12 15 22"/>
            </svg>
            专题列表
          </NavLink>
          <NavLink to="/cases/new" className="side-nav__link" title="新建专题" aria-label="新建专题">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="12" y1="18" x2="12" y2="12"/>
              <line x1="9" y1="15" x2="15" y2="15"/>
            </svg>
            新建专题
          </NavLink>
          <NavLink to="/overview" className="side-nav__link" title="数据总览" aria-label="数据总览">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="4" width="6" height="6"/>
              <rect x="14" y="4" width="6" height="6"/>
              <rect x="4" y="14" width="6" height="6"/>
              <rect x="14" y="14" width="6" height="6"/>
            </svg>
            数据总览
          </NavLink>
        </nav>
        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
