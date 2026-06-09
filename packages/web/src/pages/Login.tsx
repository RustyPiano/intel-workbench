import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { landingPathForRole, useSession } from "../state/session";

/**
 * 登录壳（产品 spec §8.1）：本地账号 + 口令，服务端校验后发放会话令牌，
 * 按角色落地。失败/锁定提示由服务端返回。
 */

/** 演示账号（首次启动预置于 config/users.json；可由管理员重置）。 */
const DEMO_ACCOUNTS = [
  { id: "operator", label: "作业员", password: "operator123" },
  { id: "admin", label: "管理员", password: "admin123" },
  { id: "security", label: "保密员", password: "security123" },
];

export function LoginPage() {
  const { signIn } = useSession();
  const navigate = useNavigate();
  const [username, setUsername] = useState("operator");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const user = await signIn(username.trim(), password);
      navigate(landingPathForRole(user.role), { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login__card">
        <h1 className="login__brand">情报分析工作台</h1>
        <p className="login__sub">离线智能情报处理与多模态分析系统</p>

        <form className="login__roles" onSubmit={handleSubmit}>
          <div className="form-label">用户名</div>
          <input
            type="text"
            className="input-text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="用户名"
            style={{ padding: "10px 12px", fontSize: "14px" }}
          />
          <div className="form-label" style={{ marginTop: "12px" }}>口令</div>
          <input
            type="password"
            className="input-text"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="口令"
            style={{ padding: "10px 12px", fontSize: "14px" }}
          />

          {error ? (
            <div style={{ color: "var(--danger-light)", fontSize: "12px", marginTop: "10px" }}>{error}</div>
          ) : null}

          <button type="submit" className="btn btn--primary login__enter" disabled={busy} style={{ marginTop: "16px" }}>
            {busy ? "登 录 中…" : "确 认 登 录"}
          </button>
        </form>

        <div className="login__notice" style={{ marginTop: "16px" }}>
          <strong>演示账号：</strong>
          {DEMO_ACCOUNTS.map((a, i) => (
            <span key={a.id}>
              {i > 0 ? " · " : ""}
              {a.label} <code>{a.id}</code> / <code>{a.password}</code>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
