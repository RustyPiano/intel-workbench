import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useParams } from "react-router-dom";

import {
  askInquiry,
  getCase,
  getMaterialContent,
  ingestMaterials,
  listInquiries,
  listMaterials,
  readFileForUpload,
  type ApiCase,
  type ApiClaim,
  type ApiInquiry,
  type ApiMaterial,
  type MaterialContent,
} from "../api";
import { useSession } from "../state/session";
import { CLEARANCE_LABELS } from "../types";

const TABS: { to: string; label: string }[] = [
  { to: "materials", label: "线索素材" },
  { to: "elements", label: "要素提取" },
  { to: "inquiry", label: "智能问答" },
  { to: "report", label: "通报起草" },
  { to: "audit", label: "专题审计" },
];

/**
 * 专题工作台外壳（产品 spec §8.4）：顶部标签页 + 子路由内容区。
 * M2：标题/密级取自真实专题 manifest。
 */
export function CaseWorkbench() {
  const { id } = useParams<{ id: string }>();
  const { user } = useSession();
  const [caseInfo, setCaseInfo] = useState<ApiCase | null>(null);

  useEffect(() => {
    if (!user || !id) return;
    let alive = true;
    getCase(user, id)
      .then((c) => alive && setCaseInfo(c))
      .catch(() => alive && setCaseInfo(null));
    return () => {
      alive = false;
    };
  }, [user, id]);

  return (
    <div className="workbench">
      <div className="workbench__head">
        <div className="workbench__title-area">
          <h1 className="workbench__title">专题工作台: {caseInfo?.name ?? id}</h1>
          <span className="workbench__status-dot" title="活跃研判中" />
          {caseInfo ? (
            <span className={`badge badge--clearance tone-${caseInfo.clearance}`} style={{ padding: "2px 8px", fontSize: "11px" }}>
              {CLEARANCE_LABELS[caseInfo.clearance]}级
            </span>
          ) : null}
        </div>
        <span className="workbench__hint">素材汇入加工（M2）与问答带溯源（M3）已接通；要素/报告为后续里程碑。</span>
      </div>

      <nav className="tabs">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} className="tabs__tab">
            {t.label}
          </NavLink>
        ))}
        <span className="tabs__spacer" />
        <NavLink to="materials" className="btn btn--primary" style={{ padding: "6px 14px", fontSize: "12px" }}>
          + 汇入线索
        </NavLink>
      </nav>

      <div className="workbench__body">
        <Outlet />
      </div>
    </div>
  );
}

// ==================== 1. Materials Sub-panel ====================

const MODALITY_LABELS: Record<ApiMaterial["modality"], string> = {
  doc: "文档",
  audio: "音频",
  video: "视频",
  image: "图片",
};

const STATUS_LABELS: Record<ApiMaterial["status"], { text: string; color: string }> = {
  pending: { text: "待加工", color: "var(--warn-light)" },
  processing: { text: "加工中", color: "var(--warn-light)" },
  done: { text: "已完成", color: "var(--ok-light)" },
  failed: { text: "失败", color: "var(--danger-light)" },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MaterialsPanel() {
  const { id: caseId } = useParams<{ id: string }>();
  const { user } = useSession();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [materials, setMaterials] = useState<ApiMaterial[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [content, setContent] = useState<MaterialContent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    if (!user || !caseId) return;
    listMaterials(user, caseId)
      .then((list) => {
        setMaterials(list);
        setActiveId((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch((e: Error) => setError(e.message));
  };

  useEffect(refresh, [user, caseId]);

  useEffect(() => {
    if (!user || !activeId) {
      setContent(null);
      return;
    }
    let alive = true;
    getMaterialContent(user, activeId)
      .then((c) => alive && setContent(c))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [user, activeId]);

  const handleFiles = async (fileList: FileList | null) => {
    if (!user || !caseId || !fileList || fileList.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await Promise.all(Array.from(fileList).map(readFileForUpload));
      const ingested = await ingestMaterials(user, caseId, payload);
      refresh();
      if (ingested[0]) setActiveId(ingested[0].id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="materials-layout">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => void handleFiles(e.target.files)}
      />

      {/* 素材侧栏 */}
      <div className="materials-sidebar">
        <div style={{ padding: "12px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: "12px", fontWeight: "700", color: "var(--text-muted)", textTransform: "uppercase" }}>
            线索素材 ({materials?.length ?? 0})
          </span>
          <button type="button" className="btn btn--primary" style={{ padding: "4px 10px", fontSize: "11px" }} disabled={busy} onClick={() => fileInputRef.current?.click()}>
            {busy ? "汇入中…" : "+ 汇入"}
          </button>
        </div>

        {error ? <div style={{ padding: "12px", fontSize: "12px", color: "var(--danger-light)" }}>{error}</div> : null}

        {materials === null ? (
          <div style={{ padding: "16px", fontSize: "13px", color: "var(--text-dim)" }}>加载中…</div>
        ) : materials.length === 0 ? (
          <div style={{ padding: "16px", fontSize: "13px", color: "var(--text-dim)", lineHeight: "1.6" }}>
            还没有素材。点击「+ 汇入」上传文档（TXT/MD/CSV/JSON/LOG 等可直接加工；PDF/Office/音视频/图片暂降级占位）。
          </div>
        ) : (
          materials.map((m) => {
            const s = STATUS_LABELS[m.status];
            return (
              <div key={m.id} className={`materials-item ${activeId === m.id ? "active" : ""}`} onClick={() => setActiveId(m.id)}>
                <div className="materials-item__title">{m.filename}</div>
                <div className="materials-item__meta">
                  <span>{MODALITY_LABELS[m.modality]} · {formatSize(m.size)}</span>
                  <span style={{ color: s.color }}>
                    {s.text}
                    {m.status === "done" && m.chunk_count !== undefined ? ` · ${m.chunk_count} 块` : ""}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 内容阅读区 */}
      <div className="materials-viewer">
        {!content ? (
          <div style={{ padding: "32px", color: "var(--text-dim)", fontSize: "14px" }}>
            {materials && materials.length === 0 ? "汇入素材后在此阅读归一化原文与切块结果。" : "选择左侧素材查看内容。"}
          </div>
        ) : (
          <>
            <div className="materials-viewer__header">
              <div className="materials-viewer__title">📄 {content.material.filename}</div>
              <div style={{ fontSize: "12px", color: "var(--text-dim)" }}>
                模态: <strong style={{ color: "#fff" }}>{MODALITY_LABELS[content.material.modality]}</strong> | 格式: {content.material.format} | 大小:{" "}
                {formatSize(content.material.size)} | 汇入: {content.material.ingested_at.replace("T", " ").slice(0, 19)}
                {content.chunkCount !== undefined ? ` | 切块: ${content.chunkCount}` : ""}
              </div>
            </div>

            <div className="materials-viewer__body">
              {content.text !== undefined ? (
                <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit", fontSize: "13px", lineHeight: "1.7", color: "var(--text)", margin: 0 }}>
                  {content.text}
                </pre>
              ) : (
                <div style={{ background: "rgba(245, 158, 11, 0.08)", border: "1px solid rgba(245, 158, 11, 0.25)", borderRadius: "var(--radius)", padding: "16px", color: "var(--warn-light)", fontSize: "13px", lineHeight: "1.6" }}>
                  ⚠️ {content.note ?? "该素材尚未加工完成。"}
                  <div style={{ marginTop: "8px", color: "var(--text-dim)" }}>
                    （一期仅文本文档做实加工；该模态待接入本地模型后接通。）
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ==================== 2. Elements Sub-panel ====================
interface ExtractedElement {
  id: string;
  name: string;
  category: "person" | "org" | "loc" | "event";
  categoryText: string;
  freq: number;
  desc: string;
  source: string;
}

const EXTRACTED_ELEMENTS: ExtractedElement[] = [
  { id: "e1", name: "Siberia_01", category: "person", categoryText: "人物", freq: 4, desc: "通话发起端特工代号，疑似外军网络战分队成员", source: "intercepted_radio_audio_transcript.txt" },
  { id: "e2", name: "APT-29 (Cozy Bear)", category: "org", categoryText: "组织", freq: 12, desc: "受某国政府资助的网络入侵组织，擅长鱼叉式钓鱼及隐蔽渗透", source: "APT29_attack_pattern_log.csv" },
  { id: "e3", name: "Moscow HQ", category: "org", categoryText: "组织", freq: 2, desc: "通话提及指令下达源头中心", source: "intercepted_radio_audio_transcript.txt" },
  { id: "e4", name: "南海X号岛礁周边", category: "loc", categoryText: "地点", freq: 3, desc: "卫星过境解译发生雷达静默的地理坐标区间", source: "satellite_imagery_analysis.pdf" },
  { id: "e5", name: "鱼叉式钓鱼宏注入", category: "event", categoryText: "事件", freq: 5, desc: "本次针对受害者边界防御绕过的初始渗透事件", source: "APT29_attack_pattern_log.csv" },
  { id: "e6", name: "SMB内网横向渗透", category: "event", categoryText: "事件", freq: 3, desc: "攻击者获取初步主机控制后在内网进行的扩散嗅探", source: "intercepted_radio_audio_transcript.txt" },
];

export function ElementsPanel() {
  const [activeCat, setActiveCat] = useState<string>("all");
  const [search, setSearch] = useState("");

  const filtered = EXTRACTED_ELEMENTS.filter((e) => {
    const matchCat = activeCat === "all" || e.category === activeCat;
    const matchSearch = e.name.toLowerCase().includes(search.toLowerCase()) || e.desc.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });

  return (
    <div className="elements-layout">
      {/* Categories */}
      <div className="elements-categories">
        <div style={{ padding: "8px 12px", fontSize: "11px", fontWeight: "700", color: "var(--text-muted)" }}>分类过滤器</div>
        <button type="button" className={`elements-cat-btn ${activeCat === "all" ? "active" : ""}`} onClick={() => setActiveCat("all")}>全部 ({EXTRACTED_ELEMENTS.length})</button>
        <button type="button" className={`elements-cat-btn ${activeCat === "person" ? "active" : ""}`} onClick={() => setActiveCat("person")}>👤 人物</button>
        <button type="button" className={`elements-cat-btn ${activeCat === "org" ? "active" : ""}`} onClick={() => setActiveCat("org")}>🏢 机构</button>
        <button type="button" className={`elements-cat-btn ${activeCat === "loc" ? "active" : ""}`} onClick={() => setActiveCat("loc")}>📍 地点</button>
        <button type="button" className={`elements-cat-btn ${activeCat === "event" ? "active" : ""}`} onClick={() => setActiveCat("event")}>⚡ 事件</button>
      </div>

      {/* Main Elements Grid */}
      <div style={{ display: "flex", flexDirection: "column", gap: "16px", minHeight: 0 }}>
        <div style={{ display: "flex", gap: "12px" }}>
          <input
            type="text"
            className="input-text"
            placeholder="🔍 过滤提取出的要素代号或说明…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ padding: "8px 12px", fontSize: "13px" }}
          />
        </div>

        <div className="elements-main">
          <table className="elements-table">
            <thead>
              <tr>
                <th>要素代号 / 名称</th>
                <th>类型</th>
                <th>提及频次</th>
                <th>出处关联</th>
                <th>要素上下文解译背景</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={item.id}>
                  <td style={{ fontWeight: "700" }}>{item.name}</td>
                  <td>
                    <span className={`entity-tag entity-tag--${item.category}`}>
                      {item.categoryText}
                    </span>
                  </td>
                  <td style={{ fontFamily: "monospace", fontSize: "14px", fontWeight: "600" }}>{item.freq}</td>
                  <td style={{ fontSize: "11px", color: "var(--accent-light)", textDecoration: "underline", maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.source}>
                    {item.source}
                  </td>
                  <td style={{ color: "var(--text-dim)", fontSize: "13px", lineHeight: "1.4" }}>{item.desc}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ textAlign: "center", color: "var(--text-muted)", padding: "40px" }}>无匹配的要素结果。M3 阶段将接入大模型批量知识图谱关联。</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ==================== 3. Inquiry Sub-panel ====================

function CitationChips({ claim }: { claim: ApiClaim }) {
  if (claim.citations.length === 0) return null;
  return (
    <span style={{ marginLeft: "6px" }}>
      {claim.citations.map((c, i) => (
        <span
          key={i}
          className="citation"
          title={`${c.material_name}${c.locator.paragraph ? ` · 第${c.locator.paragraph}段` : ""}\n${c.snippet}`}
        >
          {i + 1}
        </span>
      ))}
    </span>
  );
}

function InquiryAnswer({ inquiry }: { inquiry: ApiInquiry }) {
  if (inquiry.status !== "answered") {
    const unverified = inquiry.claims.filter((c) => c.status === "unverified");
    return (
      <div style={{ color: "var(--warn-light)", fontSize: "13px", lineHeight: "1.6" }}>
        ⚠️ {inquiry.answer}
        {unverified.length > 0 ? (
          <div style={{ marginTop: "8px", color: "var(--text-dim)" }}>
            （以下为无有效出处的待核提示，不作为事实）
            {unverified.map((c, i) => (
              <div key={i} style={{ marginTop: "4px" }}>· {c.text}</div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  const verified = inquiry.claims.filter((c) => c.status === "verified");
  return (
    <div style={{ fontSize: "13px", lineHeight: "1.7" }}>
      {verified.map((c, i) => (
        <div key={i} style={{ marginBottom: "6px" }}>
          {i + 1}. {c.text}
          {c.type === "inference" ? <span style={{ marginLeft: "6px", fontSize: "11px", color: "var(--text-muted)" }}>（推断）</span> : null}
          <CitationChips claim={c} />
        </div>
      ))}
    </div>
  );
}

export function InquiryPanel() {
  const { id: caseId } = useParams<{ id: string }>();
  const { user } = useSession();
  const [history, setHistory] = useState<ApiInquiry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !caseId) return;
    let alive = true;
    listInquiries(user, caseId)
      .then((list) => alive && setHistory(list))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [user, caseId]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = input.trim();
    if (!q || !user || !caseId || busy) return;
    setBusy(true);
    setError(null);
    setInput("");
    try {
      const inquiry = await askInquiry(user, caseId, q);
      setHistory((prev) => [...prev, inquiry]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inquiry-layout">
      <div className="chat-messages">
        {history.length === 0 && !busy ? (
          <div style={{ color: "var(--text-dim)", fontSize: "13px", lineHeight: "1.7", padding: "8px" }}>
            向 AI 提问本专题已加工素材中的关联线索。每条结论都会绑定到素材出处；无支撑时系统回「现有材料不足以判断」，不臆造。
          </div>
        ) : null}
        {history.map((inq) => (
          <div key={inq.id}>
            <div className="chat-bubble chat-bubble--user">
              <div className="chat-avatar">👤</div>
              <div className="chat-content">
                <p>{inq.question}</p>
              </div>
            </div>
            <div className="chat-bubble chat-bubble--ai">
              <div className="chat-avatar">🤖</div>
              <div className="chat-content">
                <InquiryAnswer inquiry={inq} />
              </div>
            </div>
          </div>
        ))}
        {busy ? (
          <div className="chat-bubble chat-bubble--ai">
            <div className="chat-avatar">🤖</div>
            <div className="chat-content">
              <p style={{ color: "var(--text-dim)" }}>检索素材并研判中…</p>
            </div>
          </div>
        ) : null}
        {error ? <div style={{ color: "var(--danger-light)", fontSize: "12px", padding: "8px" }}>{error}</div> : null}
      </div>

      <form onSubmit={handleSend} className="chat-input-area">
        <input
          type="text"
          className="input-text"
          placeholder="🎯 向 AI 助手提问有关本专题的关联线索…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="btn btn--primary" disabled={busy}>
          发送
        </button>
      </form>
    </div>
  );
}

// ==================== 4. Report Sub-panel ====================
export function ReportPanel() {
  const [reportTitle, setReportTitle] = useState("关于境外特定组织针对我单位基础设施网络入侵的分析通报");
  const [reportContent, setReportContent] = useState(
    `【机密 ★ 专题情况通报】\n\n一、事件概述\n2026-06-03 23:12 起，我安全保障中心监测到针对局域网主机的恶意渗透事件。经多源线索分析，基本确认为境外特定攻击组织（APT-29）所为。\n\n二、研判细节\n1. 诱饵来源：攻击者在前期通过高管邮箱钓鱼注入恶意宏，以突破防边界网关。\n2. 控制链路：发现本地IP 192.168.12.4 与远程可疑域名 update.microsoft-sys.org 存在高频加密HTTPS通信。\n3. 横向转移：检测到局域网域控主机（192.168.12.10）正遭到基于 SMB 共享的爆破嗅探。\n\n三、处置建议\n- 立即切断 192.168.12.4 主机的网络物理链接。\n- 封禁目标恶意解析域名 update.microsoft-sys.org。\n- 启动全网域控制器口令强制变更。`
  );
  const [status, setStatus] = useState<"draft" | "reviewing">("draft");

  const handleToggleStatus = () => {
    setStatus((prev) => (prev === "draft" ? "reviewing" : "draft"));
  };

  return (
    <div className="report-layout">
      {/* Editor Main */}
      <div className="report-editor">
        <div className="report-toolbar">
          <button type="button" className="btn btn--ghost" style={{ padding: "4px 8px", fontSize: "12px" }}><strong>B</strong></button>
          <button type="button" className="btn btn--ghost" style={{ padding: "4px 8px", fontSize: "12px" }}><em>I</em></button>
          <button type="button" className="btn btn--ghost" style={{ padding: "4px 8px", fontSize: "12px" }}>🔗 链接</button>
          <button type="button" className="btn btn--ghost" style={{ padding: "4px 8px", fontSize: "12px" }}>➕ 插入引文</button>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn" disabled style={{ padding: "4px 10px", fontSize: "11px" }}>套用公文模板</button>
        </div>
        
        <input
          type="text"
          className="report-title-input"
          value={reportTitle}
          onChange={(e) => setReportTitle(e.target.value)}
        />
        
        <textarea
          className="report-textarea"
          value={reportContent}
          onChange={(e) => setReportContent(e.target.value)}
        />
      </div>

      {/* Report Workflow Sidebar */}
      <div className="report-sidebar">
        <div className="report-sidebar__title">报告复核状态</div>
        
        <div className="workflow-steps">
          <div className={`workflow-step ${status === "draft" ? "workflow-step--active" : "workflow-step--done"}`}>
            <span className="workflow-dot">{status !== "draft" && "✓"}</span>
            <div>
              <div style={{ fontWeight: "700" }}>草稿起草中</div>
              <span style={{ fontSize: "11px", opacity: 0.7 }}>编写人: 演示作业员</span>
            </div>
          </div>

          <div className={`workflow-step ${status === "reviewing" ? "workflow-step--active" : ""}`}>
            <span className="workflow-dot"></span>
            <div>
              <div style={{ fontWeight: "600" }}>待保密员复核</div>
              <span style={{ fontSize: "11px", opacity: 0.7 }}>核对密级及完整性审计</span>
            </div>
          </div>

          <div className="workflow-step">
            <span className="workflow-dot"></span>
            <div>
              <div style={{ fontWeight: "600" }}>导出留存</div>
              <span style={{ fontSize: "11px", opacity: 0.7 }}>PDF / Word 本地物理隔离导出</span>
            </div>
          </div>
        </div>

        <div style={{ marginTop: "auto", borderTop: "1px solid var(--border)", paddingTop: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
          <button type="button" className="btn btn--primary" onClick={handleToggleStatus} style={{ width: "100%" }}>
            {status === "draft" ? "🚀 提交审核人复核" : "↩️ 撤回为草稿状态"}
          </button>
          
          <button type="button" className="btn btn--danger" disabled style={{ width: "100%" }} title="必须完成保密复核后方可导出文件 (M4 闸门控制)">
            📥 导出报告 (未授权)
          </button>
        </div>
      </div>
    </div>
  );
}

// ==================== 5. CaseAuditPanel Sub-panel ====================
interface AuditRow {
  id: string;
  time: string;
  operator: string;
  action: string;
  status: string;
  hash: string;
}

const AUDIT_ROWS: AuditRow[] = [
  { id: "au1", time: "2026-06-04 10:45:12", operator: "演示作业员", action: "保存通报报告草稿", status: "成功", hash: "aef98bc...78ea1f" },
  { id: "au2", time: "2026-06-04 10:22:04", operator: "演示作业员", action: "双击人工校对修正线索文本行 6", status: "成功", hash: "9bf4c02...e62f04" },
  { id: "au3", time: "2026-06-04 10:15:20", operator: "系统守护进程", action: "音频线索转写转译完成 (置信度 78%)", status: "成功", hash: "3da8ea4...b7c2df" },
  { id: "au4", time: "2026-06-04 09:30:11", operator: "系统守护进程", action: "自动提取要素及人物实体 6 条", status: "成功", hash: "d412be6...a20f98" },
  { id: "au5", time: "2026-06-04 09:12:00", operator: "演示作业员", action: "汇入外部音频与日志素材 3 份", status: "成功", hash: "021cb8e...84d63a" },
  { id: "au6", time: "2026-06-04 09:10:05", operator: "演示作业员", action: "创建分析专题骨架", status: "成功", hash: "f33b12a...ca098d" },
];

export function CaseAuditPanel() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ background: "rgba(16,24,40,0.3)", border: "1px solid var(--border)", padding: "16px 20px", borderRadius: "var(--radius)" }}>
        <h4 style={{ fontSize: "14px", fontWeight: "700", marginBottom: "4px" }}>🔒 本地审计链哈希锁（Integrity Chain）</h4>
        <p style={{ fontSize: "12px", color: "var(--text-dim)", lineHeight: "1.6" }}>
          当前专题下的所有变更日志已接入 M1 级 append-only 哈希连环锁。哈希总指纹: <code style={{ color: "var(--warn-light)", fontFamily: "monospace" }}>sha256-a9f4c3de8721c002bc0f987214da8c75</code>。任何篡改均将导致链校验失败并触发红线报警。
        </p>
      </div>

      <div className="audit-layout">
        <table className="audit-table">
          <thead>
            <tr>
              <th>时间戳</th>
              <th>操作账户</th>
              <th>研判动作</th>
              <th>执行状态</th>
              <th>防篡改指纹 (HASH)</th>
            </tr>
          </thead>
          <tbody>
            {AUDIT_ROWS.map((row) => (
              <tr key={row.id}>
                <td style={{ fontFamily: "monospace" }}>{row.time}</td>
                <td style={{ fontWeight: "600" }}>{row.operator}</td>
                <td>{row.action}</td>
                <td style={{ color: "var(--ok-light)" }}>● {row.status}</td>
                <td className="audit-hash">{row.hash}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
