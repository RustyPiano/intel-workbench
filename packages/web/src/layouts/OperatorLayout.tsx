import { NavLink, Outlet } from "react-router-dom";

import { TopBar } from "../components/TopBar";

/**
 * 作业面布局（产品 spec §3 双面分离）：作业员的工作台外壳。
 */
export function OperatorLayout() {
  return (
    <div className="app-shell">
      <TopBar breadcrumb="作业面" />
      <div className="app-body">
        <nav className="side-nav">
          <div className="side-nav__group">业务作业</div>
          <NavLink to="/" end className="side-nav__link">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
              <polyline points="9 22 9 12 15 12 15 22"/>
            </svg>
            首页 / 专题列表
          </NavLink>
          <NavLink to="/cases/new" className="side-nav__link">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="12" y1="18" x2="12" y2="12"/>
              <line x1="9" y1="15" x2="15" y2="15"/>
            </svg>
            新建专题
          </NavLink>
        </nav>
        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
