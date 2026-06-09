import { useEffect, useState } from "react";

import {
  createUser,
  listAdminUsers,
  listPrompts,
  listSkills,
  modelDoctor,
  resetUserPassword,
  setSkillEnabled,
  updateUser,
  type ApiModelDoctor,
  type ApiPrompt,
  type ApiSkill,
  type ApiUser,
} from "../api";
import { useSession } from "../state/session";
import { CLEARANCE_LABELS, ROLE_LABELS, type Clearance, type Role } from "../types";

const ROLE_OPTIONS = Object.keys(ROLE_LABELS) as Role[];
const CLEARANCE_OPTIONS = Object.keys(CLEARANCE_LABELS) as Clearance[];

/**
 * 管理后台（M5，骨架做实）。各页接通真实 /api/admin/* 接口；仅管理员可进入
 * （路由已 RequireRole admin）。
 */

function useAdminData<T>(load: (user: ReturnType<typeof useSession>["user"]) => Promise<T> | undefined) {
  const { user } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!user) return;
    let alive = true;
    Promise.resolve(load(user))
      .then((d) => alive && d !== undefined && setData(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, reloadKey]);
  return { user, data, error, reload: () => setReloadKey((k) => k + 1) };
}

/** 提示词模板（内置基线只读，产品 spec §8.11）。 */
export function AdminPromptsPage() {
  const { data: prompts, error } = useAdminData<ApiPrompt[]>((u) => (u ? listPrompts() : undefined));
  return (
    <div className="page">
      <div className="page__head">
        <h1 className="page__title">提示词模板</h1>
        <span className="badge badge--offline" style={{ padding: "4px 10px", fontSize: "11px" }}>内置基线 · 只读</span>
      </div>
      {error ? <p style={{ color: "var(--danger-light)" }}>{error}</p> : null}
      <div style={{ marginTop: "16px", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden", background: "rgba(0,0,0,0.15)" }}>
        <table className="elements-table">
          <thead>
            <tr>
              <th>模板名称</th>
              <th>用途</th>
              <th>说明</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {(prompts ?? []).map((p) => (
              <tr key={p.id}>
                <td style={{ fontWeight: "700" }}>{p.name}</td>
                <td style={{ fontFamily: "monospace", fontSize: "12px" }}>{p.role}</td>
                <td style={{ color: "var(--text-dim)", fontSize: "13px" }}>{p.description}</td>
                <td>
                  <button type="button" className="btn" style={{ padding: "4px 10px", fontSize: "11px" }} disabled>
                    只读
                  </button>
                </td>
              </tr>
            ))}
            {prompts && prompts.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ textAlign: "center", color: "var(--text-muted)", padding: "24px" }}>暂无模板</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Skill 管理：列表 / 启停 / 自检（产品 spec §8.12）。 */
export function AdminSkillsPage() {
  const { user, data: skills, error, reload } = useAdminData<ApiSkill[]>((u) => (u ? listSkills() : undefined));
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (skill: ApiSkill) => {
    if (!user) return;
    setBusy(skill.name);
    try {
      await setSkillEnabled(skill.name, !skill.enabled);
      reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <h1 className="page__title">Skill 技能管理</h1>
      <p style={{ fontSize: "13px", color: "var(--text-dim)", margin: "8px 0 16px" }}>列表 / 启停 / 自检；离线导入 Skill 不在一期。</p>
      {error ? <p style={{ color: "var(--danger-light)" }}>{error}</p> : null}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px" }}>
        {(skills ?? []).map((s) => (
          <div key={s.name} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "16px", background: "rgba(0,0,0,0.15)", display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
              <code style={{ fontSize: "13px", color: "var(--accent-light)", fontWeight: "700" }}>{s.name}</code>
              <input type="checkbox" checked={s.enabled} disabled={busy === s.name} onChange={() => void toggle(s)} style={{ width: "16px", height: "16px", accentColor: "var(--accent-light)", cursor: "pointer" }} />
            </div>
            <p style={{ fontSize: "12px", color: "var(--text-dim)", lineHeight: "1.5", flex: 1 }}>{s.description || "（无描述）"}</p>
            <p style={{ fontSize: "12px" }}>
              自检：<span style={{ color: s.healthy ? "var(--ok-light)" : "var(--danger-light)" }}>{s.healthy ? "● 通过" : "● 异常"}</span>
              <span style={{ marginLeft: "12px", color: s.enabled ? "var(--ok-light)" : "var(--text-muted)" }}>{s.enabled ? "已启用" : "已停用"}</span>
            </p>
          </div>
        ))}
        {skills && skills.length === 0 ? <p style={{ color: "var(--text-muted)" }}>未发现 Skill。</p> : null}
      </div>
    </div>
  );
}

/** 模型配置 + 自检（doctor，脱敏，产品 spec §8.13）。 */
export function AdminModelsPage() {
  const { data: doctor, error } = useAdminData<ApiModelDoctor>((u) => (u ? modelDoctor() : undefined));
  return (
    <div className="page">
      <h1 className="page__title">模型适配器配置</h1>
      <p style={{ fontSize: "13px", color: "var(--text-dim)", margin: "8px 0 16px" }}>
        仅限开源模型（开发期可接 OpenAI 兼容云端替身）。密钥不回显、不落盘。
      </p>
      {error ? <p style={{ color: "var(--danger-light)" }}>{error}</p> : null}
      {doctor ? (
        <div style={{ background: "rgba(0,0,0,0.15)", padding: "20px", border: "1px solid var(--border)", borderRadius: "var(--radius)", maxWidth: "560px", display: "flex", flexDirection: "column", gap: "14px" }}>
          <Row label="文本研判模型">
            <span style={{ color: doctor.configured ? "var(--ok-light)" : "var(--warn-light)" }}>{doctor.configured ? "● 已配置" : "○ 未配置（问答降级）"}</span>
          </Row>
          <Row label="Provider">{doctor.provider}</Row>
          <Row label="模型代号">{doctor.model || "—"}</Row>
          <Row label="端点 host">{doctor.host || "—"}</Row>
          <Row label="零外发白名单">
            <span style={{ color: doctor.allowlisted ? "var(--ok-light)" : "var(--text-muted)" }}>
              {doctor.allowlisted ? "● 已放行该 host" : "○ 不在白名单（出站将被拦截）"}
            </span>
          </Row>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", borderTop: "1px solid var(--border)", paddingTop: "12px" }}>
            自检为脱敏只读：仅核对配置与白名单，不发起对外探测调用。语音/多模态档位切换不在一期。
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: "16px", fontSize: "13px" }}>
      <span style={{ width: "140px", color: "var(--text-muted)" }}>{label}</span>
      <span style={{ fontFamily: "monospace" }}>{children}</span>
    </div>
  );
}

/** 用户与权限（config/users.json，产品 spec §8.14）：新增 / 改角色密级 / 启停 / 重置口令。 */
export function AdminUsersPage() {
  const { user: me, data: users, error, reload } = useAdminData<ApiUser[]>((u) => (u ? listAdminUsers() : undefined));
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ id: "", name: "", role: "operator" as Role, clearance: "internal" as Clearance, password: "" });

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.id.trim() || !draft.password) {
      setActionError("账号与口令为必填项");
      return;
    }
    void act(async () => {
      await createUser({ ...draft, id: draft.id.trim() });
      setDraft({ id: "", name: "", role: "operator", clearance: "internal", password: "" });
    });
  };

  const handleReset = (u: ApiUser) => {
    const pwd = window.prompt(`为「${u.name}（${u.id}）」设置新口令：`);
    if (pwd) void act(() => resetUserPassword(u.id, pwd));
  };

  return (
    <div className="page">
      <h1 className="page__title">用户与权限</h1>
      <p style={{ fontSize: "13px", color: "var(--text-dim)", margin: "8px 0 16px" }}>
        账号存于 config/users.json，口令以 scrypt 哈希落盘。新增账号即可登录；停用账号将被拒绝登录。
      </p>
      {(error || actionError) ? <p style={{ color: "var(--danger-light)" }}>{error ?? actionError}</p> : null}

      <form onSubmit={handleCreate} style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "16px" }}>
        <input className="input-text" placeholder="账号 id" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} style={{ padding: "8px 10px", fontSize: "13px", width: "120px" }} />
        <input className="input-text" placeholder="姓名" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={{ padding: "8px 10px", fontSize: "13px", width: "120px" }} />
        <select className="input-text" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as Role })} style={{ padding: "8px 10px", fontSize: "13px" }}>
          {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </select>
        <select className="input-text" value={draft.clearance} onChange={(e) => setDraft({ ...draft, clearance: e.target.value as Clearance })} style={{ padding: "8px 10px", fontSize: "13px" }}>
          {CLEARANCE_OPTIONS.map((c) => <option key={c} value={c}>{CLEARANCE_LABELS[c]}</option>)}
        </select>
        <input className="input-text" type="password" placeholder="初始口令" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} style={{ padding: "8px 10px", fontSize: "13px", width: "120px" }} />
        <button type="submit" className="btn btn--primary" disabled={busy} style={{ padding: "8px 16px", fontSize: "13px" }}>+ 新增用户</button>
      </form>

      <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden", background: "rgba(0,0,0,0.15)" }}>
        <table className="elements-table">
          <thead>
            <tr>
              <th>账号 / 姓名</th>
              <th>角色</th>
              <th>最大可访问密级</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {(users ?? []).map((u) => {
              const isSelf = u.id === me?.id;
              return (
                <tr key={u.id}>
                  <td style={{ fontWeight: "700" }}>
                    {u.name} <code style={{ fontSize: "11px", color: "var(--text-muted)" }}>({u.id})</code>
                    {isSelf ? <span style={{ fontSize: "11px", color: "var(--accent-light)", marginLeft: "6px" }}>当前账号</span> : null}
                  </td>
                  <td>
                    <select className="input-text" value={u.role} disabled={busy || isSelf} onChange={(e) => act(() => updateUser(u.id, { role: e.target.value as Role }))} style={{ padding: "4px 8px", fontSize: "12px" }}>
                      {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </select>
                  </td>
                  <td>
                    <select className="input-text" value={u.clearance} disabled={busy} onChange={(e) => act(() => updateUser(u.id, { clearance: e.target.value as Clearance }))} style={{ padding: "4px 8px", fontSize: "12px" }}>
                      {CLEARANCE_OPTIONS.map((c) => <option key={c} value={c}>{CLEARANCE_LABELS[c]}</option>)}
                    </select>
                  </td>
                  <td>
                    <span style={{ color: u.enabled ? "var(--ok-light)" : "var(--text-muted)" }}>● {u.enabled ? "活跃" : "停用"}</span>
                  </td>
                  <td style={{ display: "flex", gap: "6px" }}>
                    <button type="button" className="btn" disabled={busy || isSelf} onClick={() => act(() => updateUser(u.id, { enabled: !u.enabled }))} style={{ padding: "4px 10px", fontSize: "11px" }}>
                      {u.enabled ? "停用" : "启用"}
                    </button>
                    <button type="button" className="btn" disabled={busy} onClick={() => handleReset(u)} style={{ padding: "4px 10px", fontSize: "11px" }}>
                      重置口令
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
