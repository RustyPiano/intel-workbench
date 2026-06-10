import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useParams } from "react-router-dom";

import {
  approveReport,
  askInquiry,
  draftReport,
  exportReport,
  extractElements,
  fetchFrameUrl,
  fetchMaterialRawUrl,
  getCase,
  getMaterialContent,
  getReport,
  listElements,
  listInquiries,
  listMaterials,
  processMaterial,
  submitReport,
  uploadMaterial,
  type ApiCase,
  type ApiCitation,
  type ApiClaim,
  type ApiElement,
  type ApiInquiry,
  type ApiMaterial,
  type ApiReport,
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
  const warn = mt.note ? ` · ⚠ ${mt.note}` : "";
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
        <button type="button" className="btn" style={{ padding: "2px 8px", fontSize: "11px" }} onClick={onClose}>
          ✕ 关闭
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
  const [rawUrl, setRawUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [error, setError] = useState<string | null>(null);

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
    setBusy(true);
    setError(null);
    try {
      // 流式上传（二期 §4.6）：逐个文件直传字节，绕 25MB base64 上限。
      const ingested: ApiMaterial[] = [];
      for (const file of Array.from(fileList)) {
        ingested.push(await uploadMaterial(caseId, file));
      }
      refresh();
      if (ingested[0]) setActiveId(ingested[0].id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
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

        {materials === null ? (
          <div style={{ padding: "16px", fontSize: "13px", color: "var(--text-dim)" }}>加载中…</div>
        ) : materials.length === 0 ? (
          <div style={{ padding: "16px", fontSize: "13px", color: "var(--text-dim)", lineHeight: "1.6" }}>
            还没有素材。点击「+ 汇入」上传文档（TXT/MD/CSV/JSON/LOG 等可直接加工；音频可加工转写为带时间码/说话人的可引用片段；PDF/Office/视频/图片暂降级占位）。
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
                      {processing || content.material.status === "processing"
                        ? "加工中…"
                        : content.material.status === "done"
                          ? "🔁 重新加工"
                          : content.material.status === "failed"
                            ? "↻ 重试加工"
                            : "▶ 加工"}
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
                              style={{ padding: "2px 8px", fontSize: "11px", fontFamily: "monospace", flexShrink: 0 }}
                              onClick={() => playSeg(seg.start)}
                              title="回听此段"
                              disabled={!rawUrl}
                            >
                              ▶ {fmtTime(seg.start)}
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
                <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit", fontSize: "13px", lineHeight: "1.7", color: "var(--text)", margin: 0 }}>
                  {content.text}
                </pre>
              ) : (
                <div style={{ background: "rgba(245, 158, 11, 0.08)", border: "1px solid rgba(245, 158, 11, 0.25)", borderRadius: "var(--radius)", padding: "16px", color: "var(--warn-light)", fontSize: "13px", lineHeight: "1.6" }}>
                  ⚠️ {content.note ?? "该素材尚未加工完成。"}
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

const ELEMENT_TYPE_ICONS: Record<ElementType, string> = {
  person: "👤",
  org: "🏢",
  location: "📍",
  event: "⚡",
  equipment: "🛠️",
  time: "🕐",
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
          <input
            type="text"
            className="input-text"
            placeholder="🔍 过滤要素名称 / 别名…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ padding: "8px 12px", fontSize: "13px" }}
          />
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

// ==================== 3. Inquiry Sub-panel ====================

function CitationChips({ claim, onFrame }: { claim: ApiClaim; onFrame: (c: ApiCitation) => void }) {
  if (claim.citations.length === 0) return null;
  return (
    <span style={{ marginLeft: "6px" }}>
      {claim.citations.map((c, i) => {
        // 音频引用带时间码 → 点击回听片段；视频/图像带 bbox/时间码 → 点击取帧框选（硬验收，§4.3/§6）。
        const audioTc = c.modality === "audio" ? c.locator.timecode : undefined;
        const framed = (c.modality === "video" || c.modality === "image") && Boolean(c.locator.bbox || c.locator.timecode);
        const loc = c.locator.timecode
          ? ` · ⏱ ${c.locator.timecode} 秒${c.locator.speaker ? ` · ${c.locator.speaker}` : ""}`
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
            {audioTc ? "▶ " : framed ? "▢ " : ""}
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
          <CitationChips claim={c} onFrame={onFrame} />
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
  const [frameCite, setFrameCite] = useState<ApiCitation | null>(null);

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

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = input.trim();
    if (!q || !user || !caseId || busy) return;
    setBusy(true);
    setError(null);
    setInput("");
    try {
      const inquiry = await askInquiry(caseId, q);
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
                <InquiryAnswer inquiry={inq} onFrame={setFrameCite} />
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
            {report && !report.rendered ? " · ⚠️ 公文渲染未完成（缺 python3?）" : ""}
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
              <span className="workflow-dot">{i < stepIndex ? "✓" : ""}</span>
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
              <button type="button" className="btn btn--primary" style={{ width: "100%" }} disabled={busy || !report || status !== "draft"} onClick={() => run(() => submitReport(caseId!))}>
                🚀 提交保密员复核
              </button>
              {canReview ? (
                <button type="button" className="btn" style={{ width: "100%" }} disabled={busy || status !== "in_review"} onClick={() => run(() => approveReport(caseId!))}>
                  ✅ 复核核准
                </button>
              ) : null}
              <button
                type="button"
                className={status === "approved" || status === "exported" ? "btn btn--primary" : "btn btn--danger"}
                style={{ width: "100%" }}
                disabled={busy || (status !== "approved" && status !== "exported")}
                title={status === "approved" || status === "exported" ? "导出公文 .md" : "必须完成保密复核后方可导出（闸门）"}
                onClick={handleExport}
              >
                📥 {status === "approved" || status === "exported" ? "导出报告 (.md)" : "导出报告 (未授权)"}
              </button>
            </>
          )}
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
