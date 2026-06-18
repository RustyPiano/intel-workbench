import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { createCase } from "../api";
import { useSession } from "../state/session";
import { CLEARANCE_LABELS, type Clearance } from "../types";

/**
 * 新建专题（产品 spec §8.3）。
 * Redesigned as an interactive workspace wizard.
 */

const CLEARANCE_RANK: Record<Clearance, number> = {
  internal: 0,
  secret: 1,
  confidential: 2,
  topsecret: 3,
};

const CLEARANCE_DESCS: Record<Clearance, string> = {
  internal: "仅限内部流转与办公环境分析",
  secret: "适用于一般敏感线索及非公开日志",
  confidential: "适用于重要涉密情报与安全分析线索",
  topsecret: "高敏感重点研判及核心特种线索",
};

export function NewCasePage() {
  const navigate = useNavigate();
  const { user } = useSession();
  
  const [name, setName] = useState("");
  const [clearance, setClearance] = useState<Clearance>("internal");
  const [desc, setDesc] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const userClearance = user?.clearance ?? "internal";
  const maxRank = CLEARANCE_RANK[userClearance];

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("专题名称为必填项");
      return;
    }
    if (!user) return;
    setSubmitting(true);
    setError(null);
    try {
      // M1：真实创建并落盘（POST /api/cases）。开发模式下涉密会被服务端拒绝。
      const created = await createCase({ name: name.trim(), clearance });
      navigate(`/cases/${encodeURIComponent(created.id)}`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  const handleAddMockFile = () => {
    const mockFileNames = [
      "APT29_attack_pattern_log.csv",
      "intercepted_radio_audio_transcript.txt",
      "satellite_imagery_analysis.pdf",
      "firewall_alerts_weekly_report.xlsx",
    ];
    
    if (attachedFiles.length >= mockFileNames.length) {
      return;
    }
    
    const nextFile = mockFileNames[attachedFiles.length];
    setAttachedFiles((prev) => [...prev, nextFile]);
  };

  return (
    <div className="page">
      <div className="page__head" style={{ marginBottom: "16px" }}>
        <h1 className="page__title">创建新分析专题</h1>
        <button type="button" className="btn" onClick={() => navigate("/")}>
          返回列表
        </button>
      </div>

      <div style={{ background: "var(--bg-panel)", padding: "14px 18px", borderRadius: "var(--radius)", border: "1px solid var(--border)", marginBottom: "28px" }}>
        <p style={{ fontSize: "13px", color: "var(--text-dim)", lineHeight: "1.6" }}>
          <strong>提示：</strong>点击「确认创建」将真实创建专题并落盘（写入 manifest 与审计链）。密级不得高于当前账户权限；开发模式下禁止创建涉密专题（密级须为“内部”）。素材汇入在 M2 阶段启用。
        </p>
      </div>

      <div className="creation-container">
        <form onSubmit={handleCreate}>
          <div className="form-group">
            <label className="form-label" htmlFor="case-name">专题名称 <span style={{ color: "var(--danger-light)" }}>*</span></label>
            <input
              id="case-name"
              type="text"
              className="input-text"
              placeholder="请输入具有唯一性的专题代号，例如: SCS-2026-ATTACK…"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
            />
            {error && (
              <span style={{ color: "var(--danger-light)", fontSize: "12px", marginTop: "4px", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                  <line x1="12" y1="9" x2="12" y2="13"/>
                  <line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                {error}
              </span>
            )}
          </div>

          <div className="form-group">
            <label className="form-label">安全密级分级 <span style={{ color: "var(--text-muted)", textTransform: "none", fontSize: "11px" }}>（密级选择不得高于当前会话您的最高权限）</span></label>
            <div className="clearance-grid">
              {(Object.keys(CLEARANCE_RANK) as Clearance[]).map((level) => {
                const isDisabled = CLEARANCE_RANK[level] > maxRank;
                return (
                  <div
                    key={level}
                    className={`clearance-option ${clearance === level ? `active ${level}` : ""}`}
                    onClick={() => {
                      if (!isDisabled) setClearance(level);
                    }}
                    style={{
                      opacity: isDisabled ? 0.35 : 1,
                      cursor: isDisabled ? "not-allowed" : "pointer",
                      borderStyle: isDisabled ? "dashed" : "solid",
                    }}
                  >
                    <span className="clearance-option__title">{CLEARANCE_LABELS[level]}</span>
                    <span style={{ fontSize: "10px", color: "var(--text-dim)", display: "block", marginTop: "4px" }}>
                      {isDisabled ? "权限不足" : "可选择"}
                    </span>
                  </div>
                );
              })}
            </div>
            <p style={{ fontSize: "12px", color: "var(--text-dim)", marginTop: "4px", fontStyle: "italic" }}>
              选定密级说明：{CLEARANCE_DESCS[clearance]}
            </p>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="case-desc">专题描述背景</label>
            <textarea
              id="case-desc"
              rows={3}
              className="textarea"
              placeholder="请描述该专题研判的背景来源、核心目标和涉及的关键事件…"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">初始线索素材</label>
            <div className="dropzone" onClick={handleAddMockFile}>
              <div className="dropzone__icon" style={{ display: "flex", justifyContent: "center" }}>
                <svg className="icon-svg" style={{ width: "32px", height: "32px", opacity: 0.6 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
              </div>
              <div className="dropzone__text">点击此处模拟添加线索文件</div>
              <div className="dropzone__sub">支持 TXT, PDF, DOCX, MP3, MP4 等素材格式 (M2 阶段启用拖拽)</div>
            </div>

            {attachedFiles.length > 0 ? (
              <div style={{ marginTop: "12px", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px", background: "rgba(0,0,0,0.15)" }}>
                <span className="form-label" style={{ fontSize: "11px", display: "block", marginBottom: "8px" }}>已附加的演示文件 ({attachedFiles.length})：</span>
                <ul style={{ listStyle: "none", fontSize: "13px", display: "flex", flexDirection: "column", gap: "6px" }}>
                  {attachedFiles.map((file, idx) => (
                    <li key={idx} style={{ display: "flex", alignItems: "center", gap: "6px", color: "var(--accent-light)" }}>
                      <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                      </svg>
                      <span style={{ textDecoration: "underline" }}>{file}</span>
                      <span style={{ color: "var(--text-muted)", fontSize: "11px" }}> (待上传)</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          <div className="creation-actions">
            <button type="button" className="btn btn--ghost" onClick={() => navigate("/")}>
              取消
            </button>
            <button type="submit" className="btn btn--primary" disabled={submitting}>
              {submitting ? "创 建 中…" : "确 认 创 建"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
