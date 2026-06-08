import { useState } from "react";
import { NavLink, Outlet, useParams } from "react-router-dom";

const TABS: { to: string; label: string }[] = [
  { to: "materials", label: "线索素材" },
  { to: "elements", label: "要素提取" },
  { to: "inquiry", label: "智能问答" },
  { to: "report", label: "通报起草" },
  { to: "audit", label: "专题审计" },
];

/**
 * 专题工作台外壳（产品 spec §8.4）：顶部标签页 + 子路由内容区。
 */
export function CaseWorkbench() {
  const { id } = useParams<{ id: string }>();

  return (
    <div className="workbench">
      <div className="workbench__head">
        <div className="workbench__title-area">
          <h1 className="workbench__title">专题工作台: {id?.toUpperCase()}</h1>
          <span className="workbench__status-dot" title="活跃研判中" />
          <span className={`badge badge--clearance tone-topsecret`} style={{ padding: "2px 8px", fontSize: "11px" }}>
            绝密级研判
          </span>
        </div>
        <span className="workbench__hint">
          M0 运行中：当前使用客户端模拟状态。
        </span>
      </div>

      <nav className="tabs">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} className="tabs__tab">
            {t.label}
          </NavLink>
        ))}
        <span className="tabs__spacer" />
        <button type="button" className="btn btn--primary" style={{ padding: "6px 14px", fontSize: "12px" }}>
          + 汇入线索
        </button>
      </nav>

      <div className="workbench__body">
        <Outlet />
      </div>
    </div>
  );
}

// ==================== 1. Materials Sub-panel ====================
interface LineObject {
  text: string;
  isLowConfidence?: boolean;
  confidence?: number;
}

interface MockFile {
  id: string;
  name: string;
  type: string;
  size: string;
  time: string;
  status: string;
  confidence: string;
  content: LineObject[];
}

const MOCK_FILES: MockFile[] = [
  {
    id: "f1",
    name: "intercepted_radio_audio_transcript.txt",
    type: "语音转写",
    size: "12.4 KB",
    time: "2026-06-04 10:15",
    status: "已就绪",
    confidence: "78%",
    content: [
      { text: "[时间: 2026-06-03 23:12:44]" },
      { text: "[通话发起人: 代号 'Siberia_01']" },
      { text: "[通话接收人: 未知方]" },
      { text: "Siberia_01: 我们已经完成了第一阶段的边界测试。诱饵宏文件已通过加密通道分发。" },
      { text: "未知方: 很好，接收方的邮件网关是否有拦截迹象？" },
      { text: "Siberia_01: 没有。他们使用的是过时的安全策略。我们成功向宿主主机注入了载荷。", isLowConfidence: true, confidence: 45 },
      { text: "未知方: 注意掩盖你的来源。Moscow HQ 要求我们在 24 小时内获得内网域控控制权限。" },
      { text: "Siberia_01: 正在尝试通过 SMB 共享协议在受害网络进行横向渗透。", isLowConfidence: true, confidence: 52 },
    ]
  },
  {
    id: "f2",
    name: "APT29_attack_pattern_log.csv",
    type: "系统日志",
    size: "45.1 KB",
    time: "2026-06-04 09:30",
    status: "已就绪",
    confidence: "98%",
    content: [
      { text: "Timestamp,Source_IP,Dest_IP,Protocol,Event_Type,Details" },
      { text: "2026-06-03 23:15:02,192.168.12.4,192.168.12.10,SMB,Connection,Intrusion Attempt" },
      { text: "2026-06-03 23:15:10,192.168.12.4,192.168.12.10,SMB,Privilege Escalation,Mimikatz Dump Run" },
      { text: "2026-06-03 23:16:32,192.168.12.4,10.0.1.25,HTTPS,C2 Call,Beacon to domains 'update.microsoft-sys.org'" },
      { text: "2026-06-03 23:18:00,192.168.12.10,10.0.1.25,HTTPS,Data Exfiltration,50MB archive transmitted" }
    ]
  },
  {
    id: "f3",
    name: "satellite_imagery_analysis.pdf",
    type: "图像分析报告",
    size: "2.1 MB",
    time: "2026-06-03 16:40",
    status: "已就绪",
    confidence: "91%",
    content: [
      { text: "【卫星过境图像解译通报】" },
      { text: "解译机构: 南海前哨分析组" },
      { text: "观测目标: X号岛礁周边海域" },
      { text: "解译详情: 发现有中型护卫舰 1 艘及雷达巡逻艇 2 艘在特定经纬度海域徘徊。" },
      { text: "评估: 该活动与此前拦截到的无线电呼号频段变更事件具有时间强关联性。" }
    ]
  },
  {
    id: "f4",
    name: "firewall_alerts_weekly_report.xlsx",
    type: "安全报告",
    size: "1.2 MB",
    time: "2026-06-04 11:00",
    status: "解析中",
    confidence: "--",
    content: [
      { text: "【正在后台解析数据流...】" },
      { text: "M2 阶段将接入大模型分布式预处理 Skill，请耐心等待。" }
    ]
  }
];

export function MaterialsPanel() {
  const [activeFileId, setActiveFileId] = useState("f1");
  const activeFile = MOCK_FILES.find((f) => f.id === activeFileId) ?? MOCK_FILES[0];
  const [editLineIdx, setEditLineIdx] = useState<number | null>(null);
  const [editText, setEditText] = useState("");

  const handleEditClick = (idx: number, currentText: string) => {
    setEditLineIdx(idx);
    setEditText(currentText);
  };

  const handleSaveEdit = (idx: number) => {
    activeFile.content[idx].text = editText;
    activeFile.content[idx].isLowConfidence = false;
    setEditLineIdx(null);
  };

  return (
    <div className="materials-layout">
      {/* File Sidebar */}
      <div className="materials-sidebar">
        <div style={{ padding: "12px", borderBottom: "1px solid var(--border)", fontSize: "12px", fontWeight: "700", color: "var(--text-muted)", textTransform: "uppercase" }}>线索素材列表</div>
        {MOCK_FILES.map((f) => (
          <div
            key={f.id}
            className={`materials-item ${activeFileId === f.id ? "active" : ""}`}
            onClick={() => {
              setActiveFileId(f.id);
              setEditLineIdx(null);
            }}
          >
            <div className="materials-item__title">{f.name}</div>
            <div className="materials-item__meta">
              <span>{f.type}</span>
              <span style={{ color: f.status === "已就绪" ? "var(--ok-light)" : "var(--warn-light)" }}>
                {f.status} (置信度: {f.confidence})
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Content Viewer */}
      <div className="materials-viewer">
        <div className="materials-viewer__header">
          <div className="materials-viewer__title">
            📄 {activeFile.name}
          </div>
          <div style={{ fontSize: "12px", color: "var(--text-dim)" }}>
            类别: <strong style={{ color: "#fff" }}>{activeFile.type}</strong> | 大小: {activeFile.size} | 导入时间: {activeFile.time}
          </div>
        </div>
        
        <div className="materials-viewer__body">
          {activeFile.content.map((line, idx) => (
            <div key={idx} style={{ marginBottom: "10px", display: "flex", gap: "10px", alignItems: "flex-start" }}>
              <span style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "monospace", width: "24px", textAlign: "right", marginTop: "4px" }}>
                {idx + 1}
              </span>
              
              {editLineIdx === idx ? (
                <div style={{ display: "flex", gap: "8px", flex: 1 }}>
                  <input
                    type="text"
                    className="input-text"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    style={{ padding: "4px 8px", fontSize: "13px" }}
                  />
                  <button type="button" className="btn btn--primary" onClick={() => handleSaveEdit(idx)} style={{ padding: "4px 10px", fontSize: "11px" }}>保存</button>
                  <button type="button" className="btn btn--ghost" onClick={() => setEditLineIdx(null)} style={{ padding: "4px 10px", fontSize: "11px" }}>取消</button>
                </div>
              ) : (
                <p style={{ flex: 1, color: line.isLowConfidence ? "inherit" : "var(--text)" }}>
                  {line.isLowConfidence ? (
                    <span
                      className="highlight-low"
                      title={`语音识别置信度偏低 (${line.confidence}%)，双击可人工校对修正`}
                      onDoubleClick={() => handleEditClick(idx, line.text)}
                    >
                      {line.text} ✏️
                    </span>
                  ) : (
                    line.text
                  )}
                </p>
              )}
            </div>
          ))}
        </div>
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
interface Message {
  id: string;
  sender: "user" | "ai";
  text: string;
  citations?: { id: number; tooltip: string }[];
}

export function InquiryPanel() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "m1",
      sender: "ai",
      text: "您好！我是专题智能助手。已为您分析本专题下的所有就绪素材，自动提取了人物、组织和网络入侵链路。请问需要我为您解答什么？",
    },
    {
      id: "m2",
      sender: "user",
      text: "分析此专题下所有素材，总结主要攻击链路。",
    },
    {
      id: "m3",
      sender: "ai",
      text: "根据本专题中提取的线索素材，APT-29 组织的主要攻击链路如下：\n\n1. 初始渗透：攻击者在 2026-06-03 23:12 分左右，通过鱼叉式钓鱼邮件 [1] 投递了诱饵文档并诱导运行宏。\n2. C2 回连：宏脚本执行后运行了恶意 Beacon 载荷，通过 HTTPS 协议回连外部 C2 服务器 [2]。\n3. 横向渗透：获取局域网主机控制权后，正通过 SMB 共享协议在受害网络进行横向移动 [3]，以索取更高特权。\n\n需要我将以上攻击链大纲填充至通报草稿中吗？",
      citations: [
        { id: 1, tooltip: "来源: intercepted_radio_audio_transcript.txt 第 4 行" },
        { id: 2, tooltip: "来源: APT29_attack_pattern_log.csv 第 4 行" },
        { id: 3, tooltip: "来源: intercepted_radio_audio_transcript.txt 第 8 行" },
      ],
    },
  ]);
  const [input, setInput] = useState("");
  const [activeTooltip, setActiveTooltip] = useState<{ id: number; text: string } | null>(null);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMsg: Message = {
      id: `m-u-${Date.now()}`,
      sender: "user",
      text: input.trim(),
    };
    
    setMessages((prev) => [...prev, userMsg]);
    setInput("");

    // Simulate AI response
    setTimeout(() => {
      const aiMsg: Message = {
        id: `m-a-${Date.now()}`,
        sender: "ai",
        text: `收到关于「${userMsg.text}」的研判请求。在 M3 阶段，此处将接通 RAG（检索增强生成）管线，分析本地关联库以进行可信回答。当前展示离线模拟，未发现其他冲突的证据要素。`,
      };
      setMessages((prev) => [...prev, aiMsg]);
    }, 800);
  };

  return (
    <div className="inquiry-layout">
      <div className="chat-messages">
        {messages.map((m) => (
          <div key={m.id} className={`chat-bubble chat-bubble--${m.sender}`}>
            <div className="chat-avatar">
              {m.sender === "user" ? "👤" : "🤖"}
            </div>
            <div className="chat-content">
              <p style={{ whiteSpace: "pre-line" }}>
                {m.text.split(/(\[\d+\])/).map((part, pIdx) => {
                  const match = part.match(/\[(\d+)\]/);
                  if (match && m.citations) {
                    const citeNum = parseInt(match[1], 10);
                    const cite = m.citations.find((c) => c.id === citeNum);
                    return (
                      <span
                        key={pIdx}
                        className="citation"
                        onMouseEnter={() => {
                          if (cite) setActiveTooltip({ id: citeNum, text: cite.tooltip });
                        }}
                        onMouseLeave={() => setActiveTooltip(null)}
                        title={cite?.tooltip}
                      >
                        {citeNum}
                      </span>
                    );
                  }
                  return part;
                })}
              </p>
            </div>
          </div>
        ))}
        {activeTooltip && (
          <div style={{
            position: "absolute",
            bottom: "80px",
            left: "24px",
            background: "var(--accent)",
            color: "#fff",
            padding: "8px 12px",
            borderRadius: "var(--radius)",
            fontSize: "12px",
            boxShadow: "var(--shadow-lg)",
            border: "1px solid var(--accent-light)",
            zIndex: 10
          }}>
            🔍 <strong>溯源引文 [{activeTooltip.id}]：</strong>{activeTooltip.text}
          </div>
        )}
      </div>

      <div className="chat-suggestions">
        <button type="button" className="chat-suggestion-btn" onClick={() => setInput("总结受害资产列表")}>总结受害资产列表</button>
        <button type="button" className="chat-suggestion-btn" onClick={() => setInput("是否有外发高敏感数据迹象？")}>是否有外发高敏感数据迹象？</button>
        <button type="button" className="chat-suggestion-btn" onClick={() => setInput("导出攻击时间线要素")}>导出攻击时间线要素</button>
      </div>

      <form onSubmit={handleSend} className="chat-input-area">
        <input
          type="text"
          className="input-text"
          placeholder="🎯 向 AI 助手提问有关本专题的关联线索…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button type="submit" className="btn btn--primary">发送</button>
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
