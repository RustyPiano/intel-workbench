import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { landingPathForRole, useSession } from "../state/session";

/**
 * 登录壳（产品 spec §8.1）：本地账号 + 口令，服务端校验后发放会话令牌，
 * 按角色落地。失败/锁定提示由服务端返回。
 */

export function LoginPage() {
  const { signIn, changePassword } = useSession();
  const navigate = useNavigate();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [mustChange, setMustChange] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mustChange) {
        if (newPassword !== confirmPassword) throw new Error("两次输入的新口令不一致");
        const user = await changePassword(password, newPassword);
        navigate(landingPathForRole(user.role), { replace: true });
        return;
      }
      const user = await signIn(username.trim(), password);
      if (user.mustChangePassword) {
        setMustChange(true);
        return;
      }
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
            onChange={(e) => {
              setUsername(e.target.value);
              setMustChange(false);
            }}
            placeholder="用户名"
            style={{ padding: "10px 12px", fontSize: "14px" }}
            disabled={mustChange}
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
            disabled={mustChange}
          />
          {mustChange ? (
            <>
              <div className="form-label" style={{ marginTop: "12px" }}>新口令</div>
              <input
                type="password"
                className="input-text"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="至少 12 位"
                style={{ padding: "10px 12px", fontSize: "14px" }}
              />
              <div className="form-label" style={{ marginTop: "12px" }}>确认新口令</div>
              <input
                type="password"
                className="input-text"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="再次输入新口令"
                style={{ padding: "10px 12px", fontSize: "14px" }}
              />
            </>
          ) : null}

          {error ? (
            <div style={{ color: "var(--danger-light)", fontSize: "12px", marginTop: "10px" }}>{error}</div>
          ) : null}

          <button type="submit" className="btn btn--primary login__enter" disabled={busy} style={{ marginTop: "16px" }}>
            {busy ? "处 理 中…" : mustChange ? "确认修改口令" : "确 认 登 录"}
          </button>
        </form>
      </div>
    </div>
  );
}
