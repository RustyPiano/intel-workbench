import { useState } from "react";
import { PlaceholderPanel } from "../components/Placeholder";

/** 管理后台 · 提示词模板（产品 spec §8.11）。 */
export function AdminPromptsPage() {
  const [prompts] = useState([
    { id: "p1", name: "系统通用基座指令", role: "system", desc: "约束大模型作为防篡改的本地情报助手，遵循零臆造红线" },
    { id: "p2", name: "要素与事件关联提取", role: "extraction", desc: "自动识别文本/转译记录中的人、地点、组织及相互动作" },
    { id: "p3", name: "多源情况通报排版格式", role: "report", desc: "格式化输出符合公文排版规范的情报通报草案" },
  ]);

  return (
    <div className="page">
      <PlaceholderPanel
        title="提示词模板"
        becomes="管理各任务用的提示词模板（系统提示/要素提取/问答/报告），可编辑、版本化、启停。"
        note="M5 起以内置基线只读呈现；版本编辑、回滚在后续里程碑。"
      >
        <div style={{ marginTop: "16px", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden", background: "rgba(0,0,0,0.15)" }}>
          <table className="elements-table">
            <thead>
              <tr>
                <th>模板名称</th>
                <th>任务类型</th>
                <th>说明</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {prompts.map((p) => (
                <tr key={p.id}>
                  <td style={{ fontWeight: "700" }}>{p.name}</td>
                  <td style={{ fontFamily: "monospace", fontSize: "12px" }}>{p.role}</td>
                  <td style={{ color: "var(--text-dim)", fontSize: "13px" }}>{p.desc}</td>
                  <td><span className="badge badge--offline" style={{ padding: "2px 8px", fontSize: "11px" }}>基线就绪</span></td>
                  <td>
                    <button type="button" className="btn" style={{ padding: "4px 10px", fontSize: "11px" }} disabled>
                      只读预览
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PlaceholderPanel>
    </div>
  );
}

/** 管理后台 · Skill 管理（产品 spec §8.12）。 */
export function AdminSkillsPage() {
  const [skills, setSkills] = useState([
    { id: "s1", name: "av-dialogue-insight", title: "音视频对话情报分析", status: true, version: "v1.0.2" },
    { id: "s2", name: "intel-bulletin", title: "公文式情报通报渲染", status: true, version: "v1.1.0" },
    { id: "s3", name: "invoice-to-purchase", title: "中国电子发票要素提取", status: false, version: "v0.9.8" },
  ]);

  const toggleSkill = (id: string) => {
    setSkills((prev) =>
      prev.map((s) => (s.id === id ? { ...s, status: !s.status } : s))
    );
  };

  return (
    <div className="page">
      <PlaceholderPanel
        title="Skill 技能管理"
        becomes="管理可插拔技能（情报通报生成、音视频对话分析、关系网络抽取等）：列表 / 启停 / 自检 / 评测结果。"
        note="M5 接通既有 skill 系统（列表 + 启停 + 自检，只读为主）；离线导入 Skill 不在一期。"
      >
        <div style={{ marginTop: "16px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px" }}>
          {skills.map((s) => (
            <div key={s.id} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "16px", background: "rgba(0,0,0,0.15)", display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <h4 style={{ fontSize: "14px", fontWeight: "700" }}>{s.title}</h4>
                  <code style={{ fontSize: "11px", color: "var(--text-muted)", display: "block", marginTop: "4px" }}>{s.name} ({s.version})</code>
                </div>
                <input
                  type="checkbox"
                  checked={s.status}
                  onChange={() => toggleSkill(s.id)}
                  style={{ width: "16px", height: "16px", accentColor: "var(--accent-light)", cursor: "pointer" }}
                />
              </div>
              <p style={{ fontSize: "12px", color: "var(--text-dim)" }}>
                系统自检状态: <span style={{ color: s.status ? "var(--ok-light)" : "var(--text-muted)" }}>{s.status ? "● 通过 (12ms)" : "● 未启用"}</span>
              </p>
              <button
                type="button"
                className="btn"
                style={{ alignSelf: "flex-start", padding: "4px 10px", fontSize: "11px" }}
                onClick={() => alert(`正在对 ${s.name} 执行 doctor 健康度自检...`)}
                disabled={!s.status}
              >
                运行自检 (Doctor)
              </button>
            </div>
          ))}
        </div>
      </PlaceholderPanel>
    </div>
  );
}

/** 管理后台 · 模型配置（产品 spec §8.13）。 */
export function AdminModelsPage() {
  const [modelType, setModelType] = useState("text");

  return (
    <div className="page">
      <PlaceholderPanel
        title="模型适配器配置"
        becomes="分用途配置开源模型接入端点（文本/多模态/语音/嵌入），含连通『自检』（复用 doctor）。"
        note="M5 接通；界面提示『仅限开源模型』，密钥脱敏不回显，配置变更入审计。M0 顶栏常驻『开发模式』徽标。"
      >
        <div style={{ marginTop: "16px", display: "flex", gap: "20px", background: "rgba(0,0,0,0.15)", padding: "20px", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", width: "180px", borderRight: "1px solid var(--border)", paddingRight: "16px" }}>
            <span className="form-label" style={{ fontSize: "11px" }}>模型分类</span>
            <button type="button" className={`elements-cat-btn ${modelType === "text" ? "active" : ""}`} onClick={() => setModelType("text")}>文本研判模型</button>
            <button type="button" className={`elements-cat-btn ${modelType === "speech" ? "active" : ""}`} onClick={() => setModelType("speech")}>语音转译 (ASR)</button>
            <button type="button" className={`elements-cat-btn ${modelType === "ocr" ? "active" : ""}`} onClick={() => setModelType("ocr")}>多模态 OCR</button>
          </div>
          
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "16px" }}>
            <div className="form-group">
              <label className="form-label" htmlFor="model-endpoint">模型接口端点 (Endpoint)</label>
              <input id="model-endpoint" type="text" className="input-text" defaultValue={modelType === "text" ? "http://127.0.0.1:11434/v1" : "http://127.0.0.1:8080/asr"} />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="model-name">模型代号 (Model Tag)</label>
              <input id="model-name" type="text" className="input-text" defaultValue={modelType === "text" ? "qwen2.5-72b-instruct" : "whisper-large-v3"} />
            </div>

            <button type="button" className="btn btn--primary" style={{ alignSelf: "flex-start" }} onClick={() => alert("正在测试与该开源端点的连通性 (测试调用 /v1/models)...")}>
              测试连通性 (Doctor Check)
            </button>
          </div>
        </div>
      </PlaceholderPanel>
    </div>
  );
}

/** 管理后台 · 用户与权限（产品 spec §8.14）。 */
export function AdminUsersPage() {
  const [users] = useState([
    { id: "u1", name: "演示管理员", role: "admin", clearance: "topsecret", status: "活跃" },
    { id: "u2", name: "演示作业员", role: "operator", clearance: "confidential", status: "活跃" },
    { id: "u3", name: "演示保密员", role: "security", clearance: "topsecret", status: "活跃" },
  ]);

  return (
    <div className="page">
      <PlaceholderPanel
        title="用户与权限"
        becomes="管理本地账号、角色（作业员/管理员/保密员）、可访问密级；新增/编辑/停用/重置口令。"
        note="M5 最简实现（config/users.json）。一期预置 1 管理员 + 1 作业员 + 1 保密员。"
      >
        <div style={{ marginTop: "16px", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden", background: "rgba(0,0,0,0.15)" }}>
          <table className="elements-table">
            <thead>
              <tr>
                <th>登录名 / 真实姓名</th>
                <th>系统角色</th>
                <th>最大可访问密级</th>
                <th>使用状态</th>
                <th>管理操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td style={{ fontWeight: "700" }}>{u.name}</td>
                  <td>{u.role === "admin" ? "管理员" : u.role === "security" ? "保密员" : "研判作业员"}</td>
                  <td><span className="badge badge--clearance tone-secret">{u.clearance.toUpperCase()}</span></td>
                  <td><span style={{ color: "var(--ok-light)" }}>● {u.status}</span></td>
                  <td>
                    <button type="button" className="btn" style={{ padding: "4px 10px", fontSize: "11px", marginRight: "8px" }} disabled>编辑账户</button>
                    <button type="button" className="btn" style={{ padding: "4px 10px", fontSize: "11px" }} disabled>重置密码</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PlaceholderPanel>
    </div>
  );
}
