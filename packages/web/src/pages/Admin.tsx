import { useEffect, useMemo, useRef, useState } from "react";

import {
  createUser,
  getPromptDetail,
  getPromptVersion,
  listAdminUsers,
  listPrompts,
  listSkills,
  modelDoctor,
  resetUserPassword,
  setSkillEnabled,
  updatePrompt,
  updateUser,
  type ApiModelDoctor,
  type ApiPrompt,
  type ApiPromptDetail,
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

type PromptVersionMode = "preview" | "rollback";
type PromptVersionBusy = { ts: string; mode: PromptVersionMode } | null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}

/** 提示词模板（产品 spec §8.11）。 */
export function AdminPromptsPage() {
  const { data: prompts, error: listError } = useAdminData<ApiPrompt[]>((u) => (u ? listPrompts() : undefined));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [detail, setDetail] = useState<ApiPromptDetail | null>(null);
  const [draftBody, setDraftBody] = useState("");
  const [loadedBody, setLoadedBody] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [versionBusy, setVersionBusy] = useState<PromptVersionBusy>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ ts: string; body: string } | null>(null);

  useEffect(() => {
    if (!prompts) return;
    if (prompts.length === 0) {
      selectedIdRef.current = null;
      setSelectedId(null);
      return;
    }
    if (!selectedId || !prompts.some((p) => p.id === selectedId)) {
      selectedIdRef.current = prompts[0].id;
      setSelectedId(prompts[0].id);
    }
  }, [prompts, selectedId]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDraftBody("");
      setLoadedBody("");
      setPreview(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }

    let alive = true;
    setDetailLoading(true);
    setDetailError(null);
    setActionError(null);
    setPreview(null);
    setDetail(null);
    setDraftBody("");
    setLoadedBody("");

    void getPromptDetail(selectedId)
      .then((next) => {
        if (!alive) return;
        setDetail(next);
        setDraftBody(next.body);
        setLoadedBody(next.body);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setDetailError(errorMessage(error));
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [selectedId]);

  const versions = useMemo(() => {
    if (!detail) return [];
    return [...detail.versions].sort((a, b) => b.ts.localeCompare(a.ts));
  }, [detail]);

  const saveDisabled = saving || detailLoading || !detail || draftBody.trim().length === 0 || draftBody === loadedBody;

  const selectPrompt = (id: string) => {
    selectedIdRef.current = id;
    setSelectedId(id);
  };

  const handleSave = async () => {
    if (!selectedId || saveDisabled) return;
    const id = selectedId;
    setSaving(true);
    setActionError(null);
    try {
      await updatePrompt(id, draftBody);
      const next = await getPromptDetail(id);
      if (selectedIdRef.current !== id) return;
      setDetail(next);
      setDraftBody(next.body);
      setLoadedBody(next.body);
      setPreview(null);
    } catch (error: unknown) {
      if (selectedIdRef.current === id) setActionError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const loadVersionBody = async (ts: string, mode: PromptVersionMode) => {
    if (!selectedId || versionBusy) return;
    const id = selectedId;
    setVersionBusy({ ts, mode });
    setActionError(null);
    try {
      const body = await getPromptVersion(id, ts);
      if (selectedIdRef.current !== id) return;
      if (mode === "preview") {
        setPreview({ ts, body });
      } else {
        setDraftBody(body);
        setPreview(null);
      }
    } catch (error: unknown) {
      if (selectedIdRef.current === id) setActionError(errorMessage(error));
    } finally {
      setVersionBusy(null);
    }
  };

  return (
    <div className="page">
      <div className="page__head">
        <h1 className="page__title">提示词模板</h1>
      </div>
      {listError ? <p style={{ color: "var(--danger-light)", marginBottom: "12px" }}>{listError}</p> : null}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 360px) minmax(0, 1fr)", gap: "16px", alignItems: "start" }}>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden", background: "rgba(0,0,0,0.15)" }}>
          <table className="elements-table">
            <thead>
              <tr>
                <th>模板名称</th>
                <th>用途</th>
              </tr>
            </thead>
            <tbody>
              {(prompts ?? []).map((p) => {
                const selected = p.id === selectedId;
                return (
                  <tr key={p.id} onClick={() => selectPrompt(p.id)} style={{ cursor: "pointer", background: selected ? "rgba(99, 102, 241, 0.12)" : undefined }}>
                    <td style={{ fontWeight: "700" }}>{p.name}</td>
                    <td style={{ fontFamily: "monospace", fontSize: "12px", color: selected ? "var(--accent-light)" : "var(--text-dim)" }}>{p.role}</td>
                  </tr>
                );
              })}
              {!prompts ? (
                <tr>
                  <td colSpan={2} style={{ textAlign: "center", color: "var(--text-muted)", padding: "24px" }}>正在加载模板…</td>
                </tr>
              ) : null}
              {prompts && prompts.length === 0 ? (
                <tr>
                  <td colSpan={2} style={{ textAlign: "center", color: "var(--text-muted)", padding: "24px" }}>暂无模板</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "18px", background: "rgba(0,0,0,0.15)", minHeight: "420px" }}>
          {!selectedId ? <p style={{ color: "var(--text-muted)" }}>选择左侧模板后编辑正文。</p> : null}
          {detailLoading ? <p style={{ color: "var(--text-dim)", marginBottom: "12px" }}>正在加载模板详情…</p> : null}
          {detailError ? <p style={{ color: "var(--danger-light)", marginBottom: "12px" }}>{detailError}</p> : null}
          {actionError ? <p style={{ color: "var(--danger-light)", marginBottom: "12px" }}>{actionError}</p> : null}

          {detail ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "flex-start" }}>
                <div>
                  <h2 style={{ fontSize: "18px", marginBottom: "6px" }}>{detail.name}</h2>
                  <p style={{ color: "var(--text-dim)", fontSize: "13px", lineHeight: "1.6" }}>{detail.description}</p>
                  <p style={{ color: "var(--text-muted)", fontSize: "12px", marginTop: "8px" }}>
                    用途：<code style={{ color: "var(--accent-light)" }}>{detail.role}</code>
                    {detail.updatedAt ? <span style={{ marginLeft: "12px" }}>最后更新：{detail.updatedAt}</span> : null}
                  </p>
                </div>
                <span className={`badge ${detail.isDefault ? "badge--offline" : "badge--devmode"}`} style={{ padding: "4px 10px", fontSize: "11px" }}>
                  {detail.isDefault ? "默认（未编辑）" : `已编辑 · v${detail.version}`}
                </span>
              </div>

              <label style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <span style={{ color: "var(--text-dim)", fontSize: "12px", fontWeight: 700 }}>提示词正文</span>
                <textarea
                  className="input-text"
                  value={draftBody}
                  onChange={(e) => setDraftBody(e.target.value)}
                  disabled={saving || detailLoading}
                  style={{ minHeight: "260px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: "12px", lineHeight: "1.6", resize: "vertical" }}
                />
              </label>

              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <button type="button" className="btn btn--primary" disabled={saveDisabled} onClick={() => void handleSave()}>
                  {saving ? "保存中…" : "保存"}
                </button>
                {draftBody === loadedBody ? <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>当前无未保存修改</span> : null}
                {draftBody.trim().length === 0 ? <span style={{ color: "var(--warn-light)", fontSize: "12px" }}>正文不能为空</span> : null}
              </div>

              <section style={{ borderTop: "1px solid var(--border)", paddingTop: "16px" }}>
                <h3 style={{ fontSize: "14px", marginBottom: "10px" }}>版本历史</h3>
                {versionBusy ? <p style={{ color: "var(--text-dim)", fontSize: "12px", marginBottom: "8px" }}>正在读取历史版本…</p> : null}
                <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
                  <table className="elements-table">
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>大小</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {versions.map((v) => (
                        <tr key={v.ts}>
                          <td style={{ fontFamily: "monospace", fontSize: "12px" }}>{v.ts}</td>
                          <td style={{ color: "var(--text-dim)" }}>{v.bytes} bytes</td>
                          <td style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                            <button
                              type="button"
                              className="btn"
                              disabled={versionBusy !== null || saving}
                              onClick={() => void loadVersionBody(v.ts, "preview")}
                              style={{ padding: "4px 10px", fontSize: "11px" }}
                            >
                              {versionBusy?.ts === v.ts && versionBusy.mode === "preview" ? "读取中…" : "查看"}
                            </button>
                            <button
                              type="button"
                              className="btn"
                              disabled={versionBusy !== null || saving}
                              onClick={() => void loadVersionBody(v.ts, "rollback")}
                              style={{ padding: "4px 10px", fontSize: "11px" }}
                            >
                              {versionBusy?.ts === v.ts && versionBusy.mode === "rollback" ? "读取中…" : "回滚到此版本"}
                            </button>
                          </td>
                        </tr>
                      ))}
                      {versions.length === 0 ? (
                        <tr>
                          <td colSpan={3} style={{ textAlign: "center", color: "var(--text-muted)", padding: "18px" }}>暂无历史版本</td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </section>

              {preview ? (
                <section style={{ borderTop: "1px solid var(--border)", paddingTop: "16px" }}>
                  <h3 style={{ fontSize: "14px", marginBottom: "8px" }}>历史版本预览</h3>
                  <p style={{ color: "var(--text-muted)", fontSize: "12px", marginBottom: "8px" }}>{preview.ts}</p>
                  <textarea
                    className="input-text"
                    value={preview.body}
                    readOnly
                    style={{ minHeight: "180px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: "12px", lineHeight: "1.6", resize: "vertical" }}
                  />
                </section>
              ) : null}
            </div>
          ) : null}
        </div>
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
      <p style={{ fontSize: "13px", color: "var(--text-dim)", margin: "8px 0 16px" }}>技能列表、启停与健康自检。</p>
      {error ? <p style={{ color: "var(--danger-light)" }}>{error}</p> : null}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px" }}>
        {(skills ?? []).map((s) => (
          <div key={s.name} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "16px", background: "rgba(0,0,0,0.15)", display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
              <code style={{ fontSize: "13px", color: "var(--accent-light)", fontWeight: "700" }}>{s.name}</code>
              <input type="checkbox" checked={s.enabled} disabled={busy === s.name} onChange={() => void toggle(s)} style={{ width: "16px", height: "16px", accentColor: "var(--accent-light)", cursor: "pointer" }} />
            </div>
            <p style={{ fontSize: "12px", color: "var(--text-dim)", lineHeight: "1.5", flex: 1 }}>{s.description || "（无描述）"}</p>
            <p style={{ fontSize: "12px", display: "flex", alignItems: "center", gap: "12px" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                <span style={{ color: s.healthy ? "var(--ok-light)" : "var(--danger-light)" }}>自检：</span>
                <span className="status-dot" style={{ backgroundColor: s.healthy ? "var(--ok-light)" : "var(--danger-light)" }} />
                <span style={{ color: s.healthy ? "var(--ok-light)" : "var(--danger-light)", fontWeight: "600" }}>{s.healthy ? "通过" : "异常"}</span>
              </span>
              <span style={{ color: s.enabled ? "var(--ok-light)" : "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span className="status-dot" style={{ backgroundColor: "currentColor" }} />
                <span>{s.enabled ? "已启用" : "已停用"}</span>
              </span>
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
            <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", color: doctor.configured ? "var(--ok-light)" : "var(--warn-light)" }}>
              <span className={doctor.configured ? "status-dot" : "status-dot status-dot--empty"} style={{ backgroundColor: doctor.configured ? "currentColor" : "transparent" }} />
              <span>{doctor.configured ? "已配置" : "未配置（问答降级）"}</span>
            </span>
          </Row>
          <Row label="Provider">{doctor.provider}</Row>
          <Row label="模型代号">{doctor.model || "—"}</Row>
          <Row label="端点 host">{doctor.host || "—"}</Row>
          <Row label="出站白名单（应用层）">
            <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", color: doctor.allowlisted ? "var(--ok-light)" : "var(--text-muted)" }}>
              <span className={doctor.allowlisted ? "status-dot" : "status-dot status-dot--empty"} style={{ backgroundColor: doctor.allowlisted ? "currentColor" : "transparent" }} />
              <span>{doctor.allowlisted ? "已放行该 host" : "不在白名单（出站将被拦截）"}</span>
            </span>
          </Row>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", borderTop: "1px solid var(--border)", paddingTop: "12px" }}>
            自检为只读核对：仅校验模型配置与外发白名单，不发起任何对外探测调用。
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
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", color: u.enabled ? "var(--ok-light)" : "var(--text-muted)" }}>
                      <span className="status-dot" style={{ backgroundColor: "currentColor" }} />
                      <span>{u.enabled ? "活跃" : "停用"}</span>
                    </span>
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
