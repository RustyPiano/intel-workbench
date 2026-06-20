import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useParams } from "react-router-dom";

import {
  approveReport,
  askInquiryStream,
  deleteMaterial,
  detectContradictions,
  draftReport,
  exportReport,
  extractElements,
  fetchFrameUrl,
  fetchMaterialRawUrl,
  getCase,
  getMaterialContent,
  getReport,
  listCaseAudit,
  listContradictions,
  listElements,
  listInquiries,
  listMaterials,
  processMaterial,
  reindexMaterial,
  submitReport,
  uploadMaterial,
  type ApiCase,
  type ApiCitation,
  type ApiClaim,
  type ApiElement,
  type ApiInquiry,
  type ApiInquiryStreamEvent,
  type ApiMaterial,
  type ApiReport,
  type AuditEvent,
  type Contradiction,
  type ElementType,
  type ImageMedia,
  type MaterialContent,
  type VideoMedia,
} from "../api";
import { useSession } from "../state/session";
import { CLEARANCE_LABELS } from "../types";

const TABS: { to: string; label: string }[] = [
  { to: "materials", label: "线索素材" },
  { to: "elements", label: "要素提取" },
  { to: "contradictions", label: "矛盾检测" },
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
    getCase(id)
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
        <span className="workbench__hint">素材加工 · 要素抽取 · 问答带溯源 · 报告复核闸门 均已接通（结论均绑定素材出处）。</span>
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

function isMediaModality(m: ApiMaterial["modality"]): boolean {
  return m === "audio" || m === "video" || m === "image";
}

/** 媒体素材加工状态行文案（含部分失败 note，二期 P2.3a/b）。 */
function mediaStatusText(content: MaterialContent): string {
  const mt = content.material;
  if (mt.status === "processing") return "加工中…";
  if (mt.status !== "done") return mt.note ?? "尚未加工。点击「加工」生成可引用片段（带时间码/坐标）。";
  const eng = `引擎 ${mt.engine ?? "—"}`;
  const dur = mt.duration ? ` · ${mt.duration}s` : "";
  const warn = mt.note ? ` · 警告：${mt.note}` : "";
  if (mt.modality === "audio") return `转写完成 · ${content.segments?.length ?? 0} 段 · ${eng}${dur}${warn}`;
  if (mt.modality === "video" && content.media?.kind === "video") return `解析完成 · ${content.media.shots.length} 镜头 · ${eng}${dur}${warn}`;
  return `解析完成 · ${eng}${warn}`;
}

/** 解析时间码 "start-end"（秒）→ [start, end]（二期 P2.3a）。 */
function parseTimecode(tc?: string): [number, number] | null {
  if (!tc) return null;
  const [a, b] = tc.split("-");
  const s = Number(a);
  if (!Number.isFinite(s)) return null;
  const e = Number(b);
  return [s, Number.isFinite(e) ? e : s];
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * 回听被引用的音频片段（硬验收，二期 §6）：拉原始素材（带令牌）→ 跳播到时间码区间。
 * 用独立 Audio 元素，到段尾即停；调用方无需管理生命周期。
 */
async function playCitedSegment(materialId: string, timecode: string): Promise<void> {
  const tc = parseTimecode(timecode);
  if (!tc) return;
  let url: string;
  try {
    url = await fetchMaterialRawUrl(materialId);
  } catch {
    return; // 回放加载失败（无内联 UI 上下文）：静默放弃，不抛未处理拒绝。
  }
  const audio = new Audio(url);
  // 单次 revoke 守卫：到段尾 / 自然结束 / 出错 / 播放被拒，任一终态都释放 blob，杜绝泄漏。
  let revoked = false;
  const release = () => {
    if (!revoked) {
      revoked = true;
      URL.revokeObjectURL(url);
    }
  };
  audio.addEventListener("loadedmetadata", () => {
    audio.currentTime = tc[0];
    void audio.play().catch(release);
  });
  audio.addEventListener("timeupdate", () => {
    if (audio.currentTime >= tc[1]) {
      audio.pause();
      release();
    }
  });
  audio.addEventListener("ended", release);
  audio.addEventListener("error", release);
}

interface BBox {
  bbox: [number, number, number, number];
  label?: string;
}

/**
 * 帧图 + bbox 框选（二期 §4.3）。带令牌拉帧（视频=frame 端点按 t，图像=raw 原图）→
 * objectURL → <img>，OCR/引用区域按归一化 [x,y,w,h] 叠加描边框。
 */
function BboxImage({ materialId, frameT, boxes }: { materialId: string; frameT?: number; boxes: BBox[] }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let u: string | null = null;
    const p = frameT !== undefined ? fetchFrameUrl(materialId, frameT) : fetchMaterialRawUrl(materialId);
    p.then((x) => {
      if (alive) {
        u = x;
        setUrl(x);
      } else {
        URL.revokeObjectURL(x);
      }
    }).catch(() => alive && setUrl(null));
    return () => {
      alive = false;
      if (u) URL.revokeObjectURL(u);
      setUrl(null);
    };
  }, [materialId, frameT]);

  if (!url) return <div style={{ padding: "16px", fontSize: "12px", color: "var(--text-dim)", background: "rgba(16,24,40,0.4)", borderRadius: "var(--radius)" }}>加载帧…</div>;
  return (
    <div style={{ position: "relative", display: "inline-block", maxWidth: "100%", lineHeight: 0 }}>
      <img src={url} alt="frame" style={{ maxWidth: "100%", display: "block", borderRadius: "var(--radius)" }} />
      {boxes.map((b, i) => (
        <div
          key={i}
          title={b.label}
          style={{
            position: "absolute",
            left: `${b.bbox[0] * 100}%`,
            top: `${b.bbox[1] * 100}%`,
            width: `${b.bbox[2] * 100}%`,
            height: `${b.bbox[3] * 100}%`,
            border: "2px solid #5ee7a8",
            boxShadow: "0 0 0 1px rgba(0,0,0,0.6)",
            boxSizing: "border-box",
            pointerEvents: "none",
          }}
        />
      ))}
    </div>
  );
}

/** 视频阅读区：分镜（帧+配文+OCR 框选）+ 音轨转写（二期 P2.3b）。 */
function VideoMediaView({ materialId, media }: { materialId: string; media: VideoMedia }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={{ fontSize: "12px", color: "var(--text-dim)" }}>分镜 {media.shots.length} · 时长 {media.duration}s</div>
      {media.shots.map((shot, i) => (
        <div key={i} style={{ display: "flex", gap: "14px", flexWrap: "wrap", padding: "10px", background: "rgba(16,24,40,0.3)", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
          <div style={{ flexShrink: 0, width: "240px", maxWidth: "100%" }}>
            <BboxImage materialId={materialId} frameT={shot.t1} boxes={shot.ocr.map((o) => ({ bbox: o.bbox, label: o.text }))} />
            <div style={{ fontSize: "11px", fontFamily: "monospace", color: "var(--text-muted)", marginTop: "4px" }}>镜头 {shot.t1}–{shot.t2}s</div>
          </div>
          <div style={{ fontSize: "13px", lineHeight: 1.6, flex: 1, minWidth: "180px" }}>
            {shot.caption ? <div><strong style={{ color: "var(--accent-light)" }}>配文：</strong>{shot.caption}</div> : null}
            {shot.ocr.length ? <div style={{ marginTop: "6px" }}><strong style={{ color: "var(--accent-light)" }}>OCR：</strong>{shot.ocr.map((o) => o.text).join(" / ")}</div> : null}
          </div>
        </div>
      ))}
      {media.transcript && media.transcript.segments.length ? (
        <div>
          <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-muted)", margin: "4px 0" }}>音轨转写</div>
          {media.transcript.segments.map((seg, i) => (
            <div key={i} style={{ fontSize: "13px", padding: "3px 0" }}>
              <span style={{ fontFamily: "monospace", color: "var(--text-muted)", marginRight: "8px" }}>{seg.start}–{seg.end}s</span>
              {seg.speaker ? <strong style={{ color: "var(--accent-light)", marginRight: "6px" }}>{seg.speaker}</strong> : null}
              {seg.text}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 引用帧框选（硬验收，二期 §4.3）：bbox/timecode 引用 → 取帧（视频=frame 端点按时间码起点，
 * 图像=原图）并在帧上框出被引用区域，复核员据此核对"区域"而非仅文本。
 */
function FrameCiteView({ cite, onClose }: { cite: ApiCitation; onClose: () => void }) {
  const tc = parseTimecode(cite.locator.timecode);
  const frameT = cite.modality === "video" && tc ? tc[0] : undefined;
  const boxes = cite.locator.bbox ? [{ bbox: cite.locator.bbox, label: cite.snippet }] : [];
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px", background: "rgba(16,24,40,0.5)", display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "12px", color: "var(--text-dim)" }}>
          引用出处：{cite.material_name}
          {cite.locator.timecode ? ` · ${cite.locator.timecode}s` : ""}
        </span>
        <button type="button" className="btn" style={{ padding: "2px 8px", fontSize: "11px", display: "inline-flex", alignItems: "center", gap: "4px" }} onClick={onClose}>
          <svg className="icon-svg" style={{ width: "10px", height: "10px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
          关闭
        </button>
      </div>
      <BboxImage materialId={cite.material_id} frameT={frameT} boxes={boxes} />
      <div style={{ fontSize: "12px", color: "var(--text)" }}>{cite.snippet}</div>
    </div>
  );
}

/** 图像阅读区：原图 + OCR 区域框选 + 配文（二期 P2.3b）。 */
function ImageMediaView({ materialId, media }: { materialId: string; media: ImageMedia }) {
  return (
    <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
      <div style={{ flexShrink: 0, maxWidth: "360px" }}>
        <BboxImage materialId={materialId} boxes={media.ocr.map((o) => ({ bbox: o.bbox, label: o.text }))} />
      </div>
      <div style={{ fontSize: "13px", lineHeight: 1.7, minWidth: "200px", flex: 1 }}>
        {media.caption ? <div><strong style={{ color: "var(--accent-light)" }}>配文：</strong>{media.caption}</div> : null}
        {media.ocr.length ? (
          <div style={{ marginTop: "8px" }}>
            <strong style={{ color: "var(--accent-light)" }}>OCR：</strong>
            <ul style={{ margin: "4px 0", paddingLeft: "18px" }}>
              {media.ocr.map((o, i) => <li key={i}>{o.text}</li>)}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function MaterialsPanel() {
  const { id: caseId } = useParams<{ id: string }>();
  const { user } = useSession();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [materials, setMaterials] = useState<ApiMaterial[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [content, setContent] = useState<MaterialContent | null>(null);
  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [rawUrl, setRawUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ name: string; index: number; total: number; fraction: number } | null>(null);
  const [uploadIssues, setUploadIssues] = useState<{ name: string; message: string }[]>([]);

  const refresh = () => {
    if (!user || !caseId) return;
    listMaterials(caseId)
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
    getMaterialContent(activeId)
      .then((c) => alive && setContent(c))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [user, activeId]);

  const handleFiles = async (fileList: FileList | null) => {
    if (!user || !caseId || !fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    setBusy(true);
    setError(null);
    setUploadIssues([]);
    // 逐个文件直传字节（二期 §4.6，绕 25MB base64 上限）；单个失败不拖垮整批，收集后单列。
    const issues: { name: string; message: string }[] = [];
    let firstOk: string | null = null;
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setUploadProgress({ name: file.name, index: i + 1, total: files.length, fraction: 0 });
        try {
          const m = await uploadMaterial(caseId, file, (fraction) =>
            setUploadProgress({ name: file.name, index: i + 1, total: files.length, fraction }),
          );
          if (!firstOk) firstOk = m.id;
        } catch (e) {
          issues.push({ name: file.name, message: (e as Error).message });
        }
      }
    } finally {
      setUploadProgress(null);
      setUploadIssues(issues);
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      refresh();
      if (firstOk) setActiveId(firstOk);
    }
  };

  // 重建稠密索引（embed 端点恢复后）；完成后刷新列表与阅读区。
  const handleReindex = async (mid: string) => {
    if (!user || !caseId || reindexing) return;
    setReindexing(true);
    setError(null);
    try {
      await reindexMaterial(caseId, mid);
      refresh();
      setContent(await getMaterialContent(mid));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReindexing(false);
    }
  };

  // 删除素材（清理落盘 + 从专题摘除）；删当前选中则清空阅读区，列表回落首项。
  const handleDelete = async (mid: string) => {
    if (!user || !caseId || deleting) return;
    if (!window.confirm("确认删除该素材？将一并清除其解析文本、切块与检索索引，不可恢复。")) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteMaterial(caseId, mid);
      if (activeId === mid) {
        setActiveId(null);
        setContent(null);
      }
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  // 显式加工媒体素材（二期 P2.3a）；完成后刷新列表与阅读区。
  const handleProcess = async (mid: string) => {
    if (!user || !caseId || processing) return;
    setProcessing(true);
    setError(null);
    try {
      await processMaterial(caseId, mid);
      refresh();
      setContent(await getMaterialContent(mid));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProcessing(false);
    }
  };

  // done 音频：拉原始素材为对象 URL，供回放（带令牌，故先 fetch 再 objectURL）。
  useEffect(() => {
    if (content?.material.modality !== "audio" || !content.segments) {
      setRawUrl(null);
      return;
    }
    let alive = true;
    let url: string | null = null;
    fetchMaterialRawUrl(content.material.id)
      .then((u) => {
        if (alive) {
          url = u;
          setRawUrl(u);
        } else {
          URL.revokeObjectURL(u);
        }
      })
      .catch(() => alive && setRawUrl(null));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [content]);

  const playSeg = (start: number) => {
    const a = audioRef.current;
    if (a) {
      a.currentTime = start;
      void a.play();
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

        {uploadProgress ? (
          <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ fontSize: "11px", color: "var(--text-dim)", marginBottom: "5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {uploadProgress.fraction >= 1
                ? `服务端解析+建索引中… ${uploadProgress.index}/${uploadProgress.total} — ${uploadProgress.name}`
                : `上传中 ${uploadProgress.index}/${uploadProgress.total} · ${Math.round(uploadProgress.fraction * 100)}% — ${uploadProgress.name}`}
            </div>
            <div style={{ height: "4px", background: "rgba(255,255,255,0.1)", borderRadius: "2px", overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${Math.round(uploadProgress.fraction * 100)}%`,
                  background: "var(--accent-light)",
                  transition: "width 0.15s",
                  // 字节已传完、等服务端解析/建索引（大文档 embed 需数十秒）：进度条脉动表示仍在进行。
                  animation: uploadProgress.fraction >= 1 ? "iw-bar-pulse 1.2s ease-in-out infinite" : undefined,
                }}
              />
            </div>
          </div>
        ) : null}

        {uploadIssues.length > 0 ? (
          <div style={{ padding: "10px 12px", fontSize: "11px", color: "var(--danger-light)", borderBottom: "1px solid var(--border)", lineHeight: "1.6" }}>
            {uploadIssues.length} 个文件上传失败（其余已汇入）：
            {uploadIssues.map((it, i) => (
              <div key={i} style={{ marginTop: "2px" }}>· {it.name}：{it.message}</div>
            ))}
          </div>
        ) : null}

        {materials === null ? (
          <div style={{ padding: "16px", fontSize: "13px", color: "var(--text-dim)" }}>加载中…</div>
        ) : materials.length === 0 ? (
          <div style={{ padding: "16px", fontSize: "13px", color: "var(--text-dim)", lineHeight: "1.6" }}>
            还没有素材。点击「+ 汇入」上传：文档（TXT/MD/CSV/JSON/LOG 及 PDF/Word/PPT/Excel 均自动解析切块）；音频/视频/图片汇入后点「加工」转写/解析为带时间码/坐标的可引用片段。
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
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
                <div className="materials-viewer__title" style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                  <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                  </svg>
                  {content.material.filename}
                </div>
                <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                  {content.material.status === "done" ? (
                    <button
                      type="button"
                      className="btn"
                      style={{ padding: "4px 10px", fontSize: "11px", display: "inline-flex", alignItems: "center", gap: "4px" }}
                      disabled={reindexing || deleting}
                      onClick={() => void handleReindex(content.material.id)}
                      title="重新计算并写入稠密检索向量（embed 端点恢复后用）"
                    >
                      <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                      </svg>
                      {reindexing ? "重建中…" : "重建索引"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn--danger"
                    style={{ padding: "4px 10px", fontSize: "11px", display: "inline-flex", alignItems: "center", gap: "4px" }}
                    disabled={deleting || reindexing}
                    onClick={() => void handleDelete(content.material.id)}
                  >
                    <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>
                    </svg>
                    {deleting ? "删除中…" : "删除"}
                  </button>
                </div>
              </div>
              <div style={{ fontSize: "12px", color: "var(--text-dim)", marginTop: "4px" }}>
                模态: <strong style={{ color: "#fff" }}>{MODALITY_LABELS[content.material.modality]}</strong> | 格式: {content.material.format} | 大小:{" "}
                {formatSize(content.material.size)} | 汇入: {content.material.ingested_at.replace("T", " ").slice(0, 19)}
                {content.chunkCount !== undefined ? ` | 切块: ${content.chunkCount}` : ""}
              </div>
            </div>

            <div className="materials-viewer__body">
              {isMediaModality(content.material.modality) ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="btn btn--primary"
                      style={{ padding: "6px 14px", fontSize: "12px" }}
                      onClick={() => void handleProcess(content.material.id)}
                      disabled={processing || content.material.status === "processing"}
                    >
                      {processing || content.material.status === "processing" ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                          <svg className="icon-svg" style={{ width: "12px", height: "12px", animation: "spin 1s linear infinite" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
                          </svg>
                          加工中…
                        </span>
                      ) : content.material.status === "done" ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                          <svg className="icon-svg" style={{ width: "12px", height: "12px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                          </svg>
                          重新加工
                        </span>
                      ) : content.material.status === "failed" ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                          <svg className="icon-svg" style={{ width: "12px", height: "12px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
                          </svg>
                          重试加工
                        </span>
                      ) : (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                          <svg className="icon-svg" style={{ width: "12px", height: "12px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="5 3 19 12 5 21 5 3"/>
                          </svg>
                          开始加工
                        </span>
                      )}
                    </button>
                    <span style={{ fontSize: "12px", color: "var(--text-dim)" }}>{mediaStatusText(content)}</span>
                  </div>

                  {content.material.modality === "audio" && content.segments ? (
                    <>
                      {rawUrl ? <audio ref={audioRef} controls src={rawUrl} style={{ width: "100%" }} /> : null}
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        {content.segments.map((seg, i) => (
                          <div
                            key={i}
                            style={{ display: "flex", gap: "10px", alignItems: "flex-start", padding: "8px 10px", background: "rgba(16,24,40,0.3)", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}
                          >
                            <button
                              type="button"
                              className="btn"
                              style={{ padding: "2px 8px", fontSize: "11px", fontFamily: "monospace", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: "4px" }}
                              onClick={() => playSeg(seg.start)}
                              title="回听此段"
                              disabled={!rawUrl}
                            >
                              <svg className="icon-svg" style={{ width: "8px", height: "8px" }} viewBox="0 0 24 24" fill="currentColor">
                                <polygon points="5 3 19 12 5 21 5 3"/>
                              </svg>
                              {fmtTime(seg.start)}
                            </button>
                            <div style={{ fontSize: "13px", lineHeight: "1.6" }}>
                              {seg.speaker ? <strong style={{ color: "var(--accent-light)", marginRight: "6px" }}>{seg.speaker}</strong> : null}
                              {seg.text}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : null}

                  {content.material.modality === "video" && content.media?.kind === "video" ? (
                    <VideoMediaView materialId={content.material.id} media={content.media} />
                  ) : null}

                  {content.material.modality === "image" && content.media?.kind === "image" ? (
                    <ImageMediaView materialId={content.material.id} media={content.media} />
                  ) : null}
                </div>
              ) : content.text !== undefined ? (
                <>
                  {content.material.note ? (
                    <div style={{ background: "rgba(245, 158, 11, 0.08)", border: "1px solid rgba(245, 158, 11, 0.25)", borderRadius: "var(--radius)", padding: "8px 12px", color: "var(--warn-light)", fontSize: "12px", lineHeight: "1.6", marginBottom: "10px", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <svg className="icon-svg" style={{ color: "var(--warn-light)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                      <span>{content.material.note}</span>
                    </div>
                  ) : null}
                  <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit", fontSize: "13px", lineHeight: "1.7", color: "var(--text)", margin: 0 }}>
                    {content.text}
                  </pre>
                </>
              ) : (
                <div style={{ background: "rgba(245, 158, 11, 0.08)", border: "1px solid rgba(245, 158, 11, 0.25)", borderRadius: "var(--radius)", padding: "16px", color: "var(--warn-light)", fontSize: "13px", lineHeight: "1.6" }}>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                    <svg className="icon-svg" style={{ color: "var(--warn-light)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    <strong>{content.note ?? "该素材尚未加工完成。"}</strong>
                  </div>
                  <div style={{ marginTop: "8px", color: "var(--text-dim)" }}>
                    （视频/图像加工见 P2.3b；该模态待接入本地模型后接通。）
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

const ELEMENT_TYPE_LABELS: Record<ElementType, string> = {
  person: "人物",
  org: "组织",
  location: "地点",
  event: "事件",
  equipment: "装备",
  time: "时间",
};

const ELEMENT_TYPE_ICONS: Record<ElementType, React.ReactNode> = {
  person: (
    <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
    </svg>
  ),
  org: (
    <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><line x1="9" y1="22" x2="9" y2="16"/><line x1="15" y1="22" x2="15" y2="16"/><line x1="9" y1="16" x2="15" y2="16"/><path d="M8 6h2v2H8V6zm0 4h2v2H8v-2zm8-4h2v2h-2V6zm0 4h2v2h-2v-2z"/>
    </svg>
  ),
  location: (
    <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
    </svg>
  ),
  event: (
    <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  ),
  equipment: (
    <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
    </svg>
  ),
  time: (
    <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </svg>
  ),
};

const ELEMENT_TYPES: ElementType[] = ["person", "org", "location", "event", "equipment", "time"];

function mentionSources(el: ApiElement): string {
  return [...new Set(el.mentions.map((m) => m.material_name))].join("、");
}

export function ElementsPanel() {
  const { id: caseId } = useParams<{ id: string }>();
  const { user } = useSession();
  const [elements, setElements] = useState<ApiElement[] | null>(null);
  const [activeCat, setActiveCat] = useState<ElementType | "all">("all");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !caseId) return;
    let alive = true;
    listElements(caseId)
      .then((els) => alive && setElements(els))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [user, caseId]);

  const handleExtract = async () => {
    if (!user || !caseId || busy) return;
    setBusy(true);
    setError(null);
    try {
      setElements(await extractElements(caseId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const all = elements ?? [];
  const filtered = all.filter((e) => {
    const matchCat = activeCat === "all" || e.type === activeCat;
    const q = search.toLowerCase();
    const matchSearch = !q || e.name.toLowerCase().includes(q) || e.aliases.some((a) => a.toLowerCase().includes(q));
    return matchCat && matchSearch;
  });

  return (
    <div className="elements-layout">
      <div className="elements-categories">
        <div style={{ padding: "8px 12px", fontSize: "11px", fontWeight: "700", color: "var(--text-muted)" }}>分类过滤器</div>
        <button type="button" className={`elements-cat-btn ${activeCat === "all" ? "active" : ""}`} onClick={() => setActiveCat("all")}>
          全部 ({all.length})
        </button>
        {ELEMENT_TYPES.map((t) => (
          <button key={t} type="button" className={`elements-cat-btn ${activeCat === t ? "active" : ""}`} onClick={() => setActiveCat(t)}>
            {ELEMENT_TYPE_ICONS[t]} {ELEMENT_TYPE_LABELS[t]} ({all.filter((e) => e.type === t).length})
          </button>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "16px", minHeight: 0 }}>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <div style={{ position: "relative", display: "flex", alignItems: "center", flex: 1 }}>
            <svg className="icon-svg" style={{ position: "absolute", left: "10px", color: "var(--text-muted)", pointerEvents: "none" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              type="text"
              className="input-text"
              placeholder="过滤要素名称 / 别名…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ padding: "8px 12px 8px 32px", fontSize: "13px" }}
            />
          </div>
          <button type="button" className="btn btn--primary" style={{ whiteSpace: "nowrap" }} onClick={handleExtract} disabled={busy}>
            {busy ? "抽取中…" : elements && elements.length > 0 ? "重新抽取" : "提取要素"}
          </button>
        </div>

        {error ? <div style={{ color: "var(--danger-light)", fontSize: "12px" }}>{error}</div> : null}

        <div className="elements-main">
          <table className="elements-table">
            <thead>
              <tr>
                <th>要素名称</th>
                <th>类型</th>
                <th>提及频次</th>
                <th>出处关联</th>
                <th>别名</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={item.id}>
                  <td style={{ fontWeight: "700" }}>{item.name}</td>
                  <td>
                    <span className={`entity-tag entity-tag--${item.type}`}>{ELEMENT_TYPE_LABELS[item.type]}</span>
                  </td>
                  <td style={{ fontFamily: "monospace", fontSize: "14px", fontWeight: "600" }}>{item.freq}</td>
                  <td
                    style={{ fontSize: "12px", color: "var(--accent-light)", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={item.mentions.map((m) => `${m.material_name}${m.locator.paragraph ? ` 第${m.locator.paragraph}段` : ""}：${m.snippet}`).join("\n")}
                  >
                    {mentionSources(item)}
                  </td>
                  <td style={{ color: "var(--text-dim)", fontSize: "13px" }}>{item.aliases.join("、") || "—"}</td>
                </tr>
              ))}
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: "center", color: "var(--text-muted)", padding: "40px", lineHeight: "1.7" }}>
                    {elements === null
                      ? "加载中…"
                      : all.length === 0
                        ? "尚未抽取要素。点击「提取要素」从已加工文档中抽取人物/组织/地点/事件等（需文本模型已配置）。每个要素都会绑定到素材出处。"
                        : "无匹配的要素。"}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ==================== 3. Contradictions Sub-panel ====================

const CONTRADICTION_SCOPE_LABELS: Record<Contradiction["scope"], string> = {
  "cross-material": "跨文件",
  "intra-material": "文件内",
};

function citedClaim(text: string, citation: ApiCitation): ApiClaim {
  return { text, type: "fact", status: "verified", citations: [citation] };
}

export function ContradictionsPanel() {
  const { id: caseId } = useParams<{ id: string }>();
  const { user } = useSession();
  const [contradictions, setContradictions] = useState<Contradiction[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frameCite, setFrameCite] = useState<ApiCitation | null>(null);

  useEffect(() => {
    if (!user || !caseId) return;
    let alive = true;
    listContradictions(caseId)
      .then((items) => alive && setContradictions(items))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [user, caseId]);

  const handleDetect = async () => {
    if (!user || !caseId || busy) return;
    setBusy(true);
    setError(null);
    try {
      setContradictions(await detectContradictions(caseId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const all = contradictions ?? [];

  return (
    <div className="contradictions-layout">
      <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
        <span style={{ flex: 1, fontSize: "12px", color: "var(--text-dim)" }}>
          已发现 <strong style={{ color: "#fff" }}>{all.length}</strong> 组矛盾线索
        </span>
        <button type="button" className="btn btn--primary" style={{ whiteSpace: "nowrap" }} onClick={handleDetect} disabled={busy}>
          {busy ? "检测中…" : contradictions && contradictions.length > 0 ? "重新检测" : "检测矛盾"}
        </button>
      </div>

      {error ? <div style={{ color: "var(--danger-light)", fontSize: "12px" }}>{error}</div> : null}

      <div className="contradictions-list">
        {contradictions === null ? (
          <div style={{ color: "var(--text-muted)", padding: "40px", textAlign: "center" }}>加载中…</div>
        ) : all.length === 0 ? (
          <div style={{ color: "var(--text-muted)", padding: "40px", textAlign: "center", lineHeight: "1.7" }}>
            尚未检测到矛盾。点击「检测矛盾」从已加工素材中比对冲突陈述，每条结果都会绑定双方出处。
          </div>
        ) : (
          all.map((item) => (
            <div key={item.id} className="contradiction-row">
              <div className="contradiction-row__head">
                <div style={{ fontWeight: 700 }}>{item.attribute ? `${item.entity} · ${item.attribute}` : item.entity}</div>
                <div style={{ display: "inline-flex", gap: "8px", alignItems: "center", flexShrink: 0 }}>
                  <span className={`contradiction-scope contradiction-scope--${item.scope === "cross-material" ? "cross" : "intra"}`}>
                    {CONTRADICTION_SCOPE_LABELS[item.scope]}
                  </span>
                  <span className="contradiction-confidence">{Math.round(item.confidence * 100)}%</span>
                </div>
              </div>

              <div className="contradiction-claims">
                <div className="contradiction-claim">
                  <div className="contradiction-claim__label">陈述 A</div>
                  <div>
                    {item.claim_a.text}
                    <CitationChips claim={citedClaim(item.claim_a.text, item.claim_a.citation)} onFrame={setFrameCite} />
                  </div>
                </div>
                <div className="contradiction-claim">
                  <div className="contradiction-claim__label">陈述 B</div>
                  <div>
                    {item.claim_b.text}
                    <CitationChips claim={citedClaim(item.claim_b.text, item.claim_b.citation)} onFrame={setFrameCite} />
                  </div>
                </div>
              </div>

              <div style={{ fontSize: "12px", color: "var(--text-dim)", lineHeight: "1.7" }}>{item.rationale}</div>
            </div>
          ))
        )}
      </div>

      {frameCite ? <FrameCiteView cite={frameCite} onClose={() => setFrameCite(null)} /> : null}
    </div>
  );
}

// ==================== 4. Inquiry Sub-panel ====================

function CitationChips({ claim, onFrame }: { claim: ApiClaim; onFrame: (c: ApiCitation) => void }) {
  if (claim.citations.length === 0) return null;
  return (
    <span style={{ marginLeft: "6px" }}>
      {claim.citations.map((c, i) => {
        // 音频引用带时间码 → 点击回听片段；视频/图像带 bbox/时间码 → 点击取帧框选（硬验收，§4.3/§6）。
        const audioTc = c.modality === "audio" ? c.locator.timecode : undefined;
        const framed = (c.modality === "video" || c.modality === "image") && Boolean(c.locator.bbox || c.locator.timecode);
        const loc = c.locator.timecode
          ? ` · 时间：${c.locator.timecode}秒${c.locator.speaker ? ` · 说话人：${c.locator.speaker}` : ""}`
          : c.locator.paragraph
            ? ` · 第${c.locator.paragraph}段`
            : "";
        const onClick = audioTc ? () => void playCitedSegment(c.material_id, audioTc) : framed ? () => onFrame(c) : undefined;
        const hint = audioTc ? "\n（点击回听被引用片段）" : framed ? "\n（点击查看引用帧并框选）" : "";
        return (
          <span
            key={i}
            className="citation"
            style={onClick ? { cursor: "pointer" } : undefined}
            title={`${c.material_name}${loc}\n${c.snippet}${hint}`}
            onClick={onClick}
          >
            {audioTc ? (
              <svg className="icon-svg" style={{ width: "8px", height: "8px", marginRight: "3px", fill: "currentColor", verticalAlign: "middle" }} viewBox="0 0 24 24" stroke="none">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            ) : framed ? (
              <svg className="icon-svg" style={{ width: "8px", height: "8px", marginRight: "3px", verticalAlign: "middle" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              </svg>
            ) : null}
            {i + 1}
          </span>
        );
      })}
    </span>
  );
}

function InquiryAnswer({ inquiry, onFrame }: { inquiry: ApiInquiry; onFrame: (c: ApiCitation) => void }) {
  if (inquiry.status !== "answered") {
    const unverified = inquiry.claims.filter((c) => c.status === "unverified");
    return (
      <div style={{ color: "var(--warn-light)", fontSize: "13px", lineHeight: "1.6", display: "inline-flex", alignItems: "flex-start", gap: "6px" }}>
        <svg className="icon-svg" style={{ color: "var(--warn-light)", marginTop: "3px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <div>
          {inquiry.answer}
          {unverified.length > 0 ? (
            <div style={{ marginTop: "8px", color: "var(--text-dim)" }}>
              （以下为无有效出处的待核提示，不作为事实）
              {unverified.map((c, i) => (
                <div key={i} style={{ marginTop: "4px" }}>· {c.text}</div>
              ))}
            </div>
          ) : null}
        </div>
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
          <CitationChips claim={c} onFrame={onFrame} />
        </div>
      ))}
    </div>
  );
}

interface ToolTraceEntry {
  key: string;
  name: string;
  status: "running" | "ok" | "failed";
}

export function InquiryPanel() {
  const { id: caseId } = useParams<{ id: string }>();
  const { user } = useSession();
  const [history, setHistory] = useState<ApiInquiry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frameCite, setFrameCite] = useState<ApiCitation | null>(null);
  const [liveQuestion, setLiveQuestion] = useState<string | null>(null);
  const [liveText, setLiveText] = useState("");
  const [toolTrace, setToolTrace] = useState<ToolTraceEntry[]>([]);
  const streamControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const userStoppedRef = useRef(false);
  const toolOrderRef = useRef(0);

  useEffect(() => {
    if (!user || !caseId) return;
    let alive = true;
    listInquiries(caseId)
      .then((list) => alive && setHistory(list))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [user, caseId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      userStoppedRef.current = true;
      streamControllerRef.current?.abort();
    };
  }, []);

  const clearLiveState = () => {
    setLiveQuestion(null);
    setLiveText("");
    setToolTrace([]);
  };

  const handleStreamEvent = (event: ApiInquiryStreamEvent) => {
    if (!mountedRef.current || userStoppedRef.current) return;
    if (event.type === "token") {
      setLiveText((prev) => prev + event.text);
      return;
    }
    if (event.type === "tool_start") {
      const key = `${event.name}:${toolOrderRef.current}`;
      toolOrderRef.current += 1;
      setToolTrace((prev) => [...prev, { key, name: event.name, status: "running" }]);
      return;
    }
    if (event.type === "tool_result") {
      setToolTrace((prev) => {
        const runningIndex = prev.findIndex((entry) => entry.name === event.name && entry.status === "running");
        const status = event.ok ? "ok" : "failed";
        if (runningIndex === -1) {
          const key = `${event.name}:${toolOrderRef.current}`;
          toolOrderRef.current += 1;
          return [...prev, { key, name: event.name, status }];
        }
        return prev.map((entry, index) => (index === runningIndex ? { ...entry, status } : entry));
      });
      return;
    }
    if (event.type === "done") {
      setHistory((prev) => [...prev, event.inquiry]);
      clearLiveState();
      return;
    }
    if (event.type === "error") {
      setError(event.message);
      clearLiveState();
    }
  };

  const handleStop = () => {
    userStoppedRef.current = true;
    streamControllerRef.current?.abort();
    clearLiveState();
    setBusy(false);
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = input.trim();
    if (!q || !user || !caseId || busy) return;
    const controller = new AbortController();
    streamControllerRef.current = controller;
    userStoppedRef.current = false;
    toolOrderRef.current = 0;
    setBusy(true);
    setError(null);
    setInput("");
    setLiveQuestion(q);
    setLiveText("");
    setToolTrace([]);
    try {
      await askInquiryStream(caseId, q, handleStreamEvent, controller.signal);
    } catch (err) {
      if (!userStoppedRef.current && mountedRef.current) {
        setError((err as Error).message);
        clearLiveState();
      }
    } finally {
      if (mountedRef.current) {
        if (streamControllerRef.current === controller) streamControllerRef.current = null;
        setBusy(false);
      }
    }
  };

  return (
    <div className="inquiry-layout">
      <div className="chat-messages">
        {history.length === 0 && !busy && !liveQuestion ? (
          <div style={{ color: "var(--text-dim)", fontSize: "13px", lineHeight: "1.7", padding: "8px" }}>
            向 AI 提问本专题已加工素材中的关联线索。每条结论都会绑定到素材出处；无支撑时系统回「现有材料不足以判断」，不臆造。
          </div>
        ) : null}
        {history.map((inq) => (
          <div key={inq.id}>
            <div className="chat-bubble chat-bubble--user">
              <div className="chat-avatar">
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                </svg>
              </div>
              <div className="chat-content">
                <p>{inq.question}</p>
              </div>
            </div>
            <div className="chat-bubble chat-bubble--ai">
              <div className="chat-avatar">
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4M8 15h.01M16 15h.01"/>
                </svg>
              </div>
              <div className="chat-content">
                <InquiryAnswer inquiry={inq} onFrame={setFrameCite} />
              </div>
            </div>
          </div>
        ))}
        {liveQuestion ? (
          <>
            <div className="chat-bubble chat-bubble--user">
              <div className="chat-avatar">
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                </svg>
              </div>
              <div className="chat-content">
                <p>{liveQuestion}</p>
              </div>
            </div>
            <div className="chat-bubble chat-bubble--ai chat-bubble--live">
              <div className="chat-avatar">
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4M8 15h.01M16 15h.01"/>
                </svg>
              </div>
              <div className="chat-content">
                <p className="live-narration">{liveText || "研判中…"}</p>
                {toolTrace.length > 0 ? (
                  <div className="tool-trace" aria-label="工具调用轨迹">
                    {toolTrace.map((entry) => (
                      <div key={entry.key} className={`tool-trace__item tool-trace__item--${entry.status}`}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                          <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                          </svg>
                          调用 {entry.name}…
                        </span>
                        <span>
                          {entry.status === "running" ? (
                            "进行中"
                          ) : entry.status === "ok" ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                              <svg className="icon-svg" style={{ color: "var(--ok-light)", width: "12px", height: "12px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12"/>
                              </svg>
                              成功
                            </span>
                          ) : (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                              <svg className="icon-svg" style={{ color: "var(--danger-light)", width: "12px", height: "12px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                              </svg>
                              失败
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
        {busy && !liveQuestion ? (
          <div className="chat-bubble chat-bubble--ai chat-bubble--live">
            <div className="chat-avatar">
              <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4M8 15h.01M16 15h.01"/>
              </svg>
            </div>
            <div className="chat-content">
              <p className="live-narration">研判中…</p>
            </div>
          </div>
        ) : null}
        {error ? <div style={{ color: "var(--danger-light)", fontSize: "12px", padding: "8px" }}>{error}</div> : null}
        {frameCite ? (
          <div style={{ padding: "8px" }}>
            <FrameCiteView cite={frameCite} onClose={() => setFrameCite(null)} />
          </div>
        ) : null}
      </div>

      <form onSubmit={handleSend} className="chat-input-area">
        <input
          type="text"
          className="input-text"
          placeholder="向 AI 助手提问有关本专题的关联线索…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="btn btn--primary" disabled={busy}>
          发送
        </button>
        {busy ? (
          <button type="button" className="btn btn--danger" onClick={handleStop}>
            停止
          </button>
        ) : null}
      </form>
    </div>
  );
}

// ==================== 5. Report Sub-panel ====================

const REPORT_STEPS: { status: ApiReport["status"]; label: string; hint: string }[] = [
  { status: "draft", label: "草稿起草", hint: "编辑标题与正文，保存即落盘并渲染公文" },
  { status: "in_review", label: "待保密员复核", hint: "提交后由保密员/管理员核对密级与完整性" },
  { status: "approved", label: "已复核", hint: "复核通过，方可导出" },
  { status: "exported", label: "已导出", hint: "导出留存（动作入审计）" },
];

function specToBody(report: ApiReport | null): string {
  if (!report) return "";
  return report.spec.sections.map((s) => (s.heading ? `${s.heading}\n${s.body}` : s.body)).join("\n\n");
}

export function ReportPanel() {
  const { id: caseId } = useParams<{ id: string }>();
  const { user } = useSession();
  const canReview = user?.role === "security" || user?.role === "admin";

  const [report, setReport] = useState<ApiReport | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!user || !caseId) return;
    let alive = true;
    getReport(caseId)
      .then((r) => {
        if (!alive) return;
        setReport(r);
        if (r) {
          setTitle(r.spec.title);
          setBody(specToBody(r));
        }
        setLoaded(true);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [user, caseId]);

  const run = async (fn: () => Promise<ApiReport>) => {
    if (!user || !caseId || busy) return;
    setBusy(true);
    setError(null);
    try {
      setReport(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveDraft = () => {
    if (!title.trim()) {
      setError("报告标题为必填项");
      return;
    }
    void run(() => draftReport(caseId!, { title: title.trim(), body }));
  };

  const handleExport = async () => {
    if (!user || !caseId) return;
    setBusy(true);
    setError(null);
    try {
      const out = await exportReport(caseId);
      const blob = new Blob([out.content], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = out.filename;
      a.click();
      URL.revokeObjectURL(url);
      setReport((prev) => (prev ? { ...prev, status: out.status } : prev));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const status = report?.status ?? "draft";
  const stepIndex = REPORT_STEPS.findIndex((s) => s.status === status);

  return (
    <div className="report-layout">
      <div className="report-editor">
        <div className="report-toolbar">
          <span style={{ fontSize: "12px", color: "var(--text-dim)" }}>
            状态：<strong style={{ color: "var(--accent-light)" }}>{REPORT_STEPS[stepIndex]?.label ?? "草稿起草"}</strong>
            {report?.spec.classification ? ` · 密级 ${report.spec.classification}` : ""}
            {report && !report.rendered ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", marginLeft: "8px", color: "var(--danger-light)" }}>
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                公文渲染未完成（缺 python3?）
              </span>
            ) : ""}
          </span>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn--primary" style={{ padding: "4px 12px", fontSize: "12px" }} onClick={handleSaveDraft} disabled={busy}>
            {busy ? "处理中…" : report ? "保存修改（回草稿）" : "生成草稿"}
          </button>
        </div>

        <input type="text" className="report-title-input" placeholder="报告标题，例如：关于某网络入侵事件的情况通报" value={title} onChange={(e) => setTitle(e.target.value)} />

        <textarea
          className="report-textarea"
          placeholder="正文：可分多段填写基本情况、分析研判、处置建议……保存后由 intel-bulletin 渲染为公文格式。"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {error ? <div style={{ color: "var(--danger-light)", fontSize: "12px", padding: "8px 0" }}>{error}</div> : null}
      </div>

      <div className="report-sidebar">
        <div className="report-sidebar__title">报告复核状态</div>

        <div className="workflow-steps">
          {REPORT_STEPS.map((step, i) => (
            <div key={step.status} className={`workflow-step ${i === stepIndex ? "workflow-step--active" : i < stepIndex ? "workflow-step--done" : ""}`}>
              <span className="workflow-dot">
                {i < stepIndex ? (
                  <svg className="icon-svg" style={{ width: "8px", height: "8px", verticalAlign: "middle" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                ) : ""}
              </span>
              <div>
                <div style={{ fontWeight: i === stepIndex ? "700" : "600" }}>{step.label}</div>
                <span style={{ fontSize: "11px", opacity: 0.7 }}>{step.hint}</span>
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: "auto", borderTop: "1px solid var(--border)", paddingTop: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
          {!loaded ? (
            <span style={{ fontSize: "12px", color: "var(--text-dim)" }}>加载报告状态…</span>
          ) : (
            <>
              <button type="button" className="btn btn--primary" style={{ width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px" }} disabled={busy || !report || status !== "draft"} onClick={() => run(() => submitReport(caseId!))}>
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
                提交保密员复核
              </button>
              {canReview ? (
                <button type="button" className="btn" style={{ width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px" }} disabled={busy || status !== "in_review"} onClick={() => run(() => approveReport(caseId!))}>
                  <svg className="icon-svg" style={{ color: "var(--ok-light)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                  复核核准
                </button>
              ) : null}
              <button
                type="button"
                className={status === "approved" || status === "exported" ? "btn btn--primary" : "btn btn--danger"}
                style={{ width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                disabled={busy || (status !== "approved" && status !== "exported")}
                title={status === "approved" || status === "exported" ? "导出公文 .md" : "必须完成保密复核后方可导出（闸门）"}
                onClick={handleExport}
              >
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                {status === "approved" || status === "exported" ? "导出报告 (.md)" : "导出报告 (未授权)"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ==================== 6. CaseAuditPanel Sub-panel ====================

/** 审计动作码 → 中文研判动作（未知码原样显示）。 */
const AUDIT_ACTION_LABELS: Record<string, string> = {
  "case.create": "创建专题",
  "case.update": "更新专题",
  "material.ingest": "汇入素材",
  "material.process": "加工媒体素材",
  "material.index": "建稠密索引",
  "material.reindex": "重建稠密索引",
  "material.delete": "删除素材",
  "inquiry.create": "智能问答",
  "inquiry.retrieve": "检索取材",
  "element.extract": "提取要素",
  "report.draft": "起草通报",
  "report.submit": "提交复核",
  "report.approve": "复核核准",
  "report.export": "导出通报",
  "audit.export": "导出审计",
};

const AUDIT_RESULT: Record<AuditEvent["result"], { text: string; color: string }> = {
  ok: { text: "成功", color: "var(--ok-light)" },
  deny: { text: "拒绝", color: "var(--warn-light)" },
  error: { text: "失败", color: "var(--danger-light)" },
};

function auditActionLabel(e: AuditEvent): string {
  return AUDIT_ACTION_LABELS[e.action] ?? e.action;
}

export function CaseAuditPanel() {
  const { id: caseId } = useParams<{ id: string }>();
  const { user } = useSession();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !caseId) return;
    let alive = true;
    listCaseAudit(caseId)
      .then((es) => alive && setEvents(es))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [user, caseId]);

  const last = events && events.length > 0 ? events[events.length - 1] : null;
  // 倒序：最新动作在前。
  const rows = events ? [...events].reverse() : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ background: "rgba(16,24,40,0.3)", border: "1px solid var(--border)", padding: "16px 20px", borderRadius: "var(--radius)" }}>
        <h4 style={{ fontSize: "14px", fontWeight: "700", marginBottom: "4px", display: "inline-flex", alignItems: "center", gap: "6px" }}>
          <svg className="icon-svg" style={{ width: "14px", height: "14px", color: "var(--accent-light)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
          本地审计链完整性校验（Integrity Chain）
        </h4>
        <p style={{ fontSize: "12px", color: "var(--text-dim)", lineHeight: "1.6" }}>
          本专题所有变更经 append-only 哈希连环锁记录（镜像自全局审计链）。共 <strong style={{ color: "#fff" }}>{events?.length ?? "…"}</strong> 条事件
          {last ? (
            <>
              ；末位指纹 <code style={{ color: "var(--warn-light)", fontFamily: "monospace" }}>{last.event_hash.slice(0, 12)}…{last.event_hash.slice(-6)}</code>
            </>
          ) : null}
          。任何篡改都会令链校验失败（审计中心可一键 verify）。
        </p>
      </div>

      {error ? <div style={{ color: "var(--danger-light)", fontSize: "12px" }}>{error}</div> : null}

      <div className="audit-layout">
        <table className="audit-table">
          <thead>
            <tr>
              <th>时间戳</th>
              <th>操作账户</th>
              <th>研判动作</th>
              <th>对象</th>
              <th>执行状态</th>
              <th>防篡改指纹 (HASH)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const r = AUDIT_RESULT[e.result];
              return (
                <tr key={e.id}>
                  <td style={{ fontFamily: "monospace" }}>{e.ts.replace("T", " ").slice(0, 19)}</td>
                  <td style={{ fontWeight: "600" }}>{e.user}</td>
                  <td>{auditActionLabel(e)}</td>
                  <td style={{ fontFamily: "monospace", fontSize: "12px", color: "var(--text-dim)" }}>{e.object}</td>
                  <td style={{ color: r.color }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <span className="status-dot" style={{ backgroundColor: "currentColor" }} />
                      <span>{r.text}</span>
                    </span>
                  </td>
                  <td className="audit-hash">{e.event_hash.slice(0, 10)}…{e.event_hash.slice(-6)}</td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", color: "var(--text-muted)", padding: "32px" }}>
                  {events === null ? "加载审计记录…" : "本专题暂无审计事件。"}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
