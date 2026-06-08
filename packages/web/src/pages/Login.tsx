import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router-dom";

import { landingPathForRole, useSession } from "../state/session";
import { CLEARANCE_LABELS, ROLE_LABELS, type Clearance, type Role } from "../types";

/**
 * 登录壳（产品 spec §8.1）。
 * Redesigned with premium cyber-style cards.
 */

interface RoleOption {
  role: Role;
  clearance: Clearance;
  desc: string;
  icon: ReactNode;
}

export function LoginPage() {
  const { signIn } = useSession();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Role>("operator");

  const ROLES: RoleOption[] = [
    {
      role: "operator",
      clearance: "confidential",
      desc: "专题工作台：建专题、汇入、分析、起草报告",
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
          <polyline points="14 2 14 8 20 8"/>
          <path d="M8 13h8"/>
          <path d="M8 17h8"/>
          <path d="M10 9H8"/>
        </svg>
      )
    },
    {
      role: "admin",
      clearance: "topsecret",
      desc: "管理后台：提示词 / Skill / 模型 / 用户配置",
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      )
    },
    {
      role: "security",
      clearance: "topsecret",
      desc: "审计中心（只读）：查全量审计、复核、导出留存",
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
      )
    }
  ];

  const handleEnter = () => {
    const choice = ROLES.find((r) => r.role === selected) ?? ROLES[0];
    signIn({
      id: `dev-${choice.role}`,
      name: `演示${ROLE_LABELS[choice.role]}`,
      role: choice.role,
      clearance: choice.clearance,
    });
    navigate(landingPathForRole(choice.role), { replace: true });
  };

  return (
    <div className="login">
      <div className="login__card">
        <h1 className="login__brand">情报分析工作台</h1>
        <p className="login__sub">离线智能情报处理与多模态分析系统 · M0 演示会话</p>

        <div className="login__notice">
          <strong>系统提示：</strong>当前处于 M0 阶段。请选择一个角色以相应权限进入作业面或管理面（角色凭证保存在本地会话）。
        </div>

        <div className="login__roles">
          <div className="form-label">选择登录角色</div>
          {ROLES.map((r) => (
            <div
              key={r.role}
              className={`login__role ${selected === r.role ? "is-selected" : ""}`}
              onClick={() => setSelected(r.role)}
              role="radio"
              aria-checked={selected === r.role}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px", color: selected === r.role ? "var(--accent-light)" : "var(--text-dim)" }}>
                {r.icon}
                <span className="login__role-name">{ROLE_LABELS[r.role]}</span>
              </div>
              <span className="login__role-clearance">
                密级：{CLEARANCE_LABELS[r.clearance]}
              </span>
              <span className="login__role-desc">{r.desc}</span>
            </div>
          ))}
        </div>

        <button type="button" className="btn btn--primary login__enter" onClick={handleEnter}>
          确 认 登 录
        </button>
      </div>
    </div>
  );
}
