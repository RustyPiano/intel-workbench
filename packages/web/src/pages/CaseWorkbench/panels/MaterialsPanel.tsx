import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  deleteMaterial,
  fetchMaterialRawUrl,
  getMaterialContent,
  listMaterials,
  processMaterial,
  reindexMaterial,
  uploadMaterial,
  uploadMaterialsBatch,
  type ApiMaterial,
  type ImageMedia,
  type MaterialContent,
  type VideoMedia,
} from "../../../api";
import { useSession } from "../../../state/session";
import { useWorkbenchContext } from "../../CaseWorkbench";
import { BboxImage } from "../components/BboxImage";
import {
  elapsedLabel,
  formatSize,
  fmtTime,
  isMediaModality,
  materialListStatus,
  mediaStatusText,
  MODALITY_LABELS,
  needsMaterialConfig,
  resolveFocusSpan,
} from "../components/helpers";

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
  const [searchParams] = useSearchParams();
  const { user } = useSession();
  const { canManage, refreshStatus } = useWorkbenchContext();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [materials, setMaterials] = useState<ApiMaterial[] | null>(null);
  const [materialFilter, setMaterialFilter] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const appliedFocusKeyRef = useRef<string | null>(null);
  const [content, setContent] = useState<MaterialContent | null>(null);
  const [busy, setBusy] = useState(false);
  const [processingIds, setProcessingIds] = useState<Set<string>>(() => new Set());
  const [processStartedAt, setProcessStartedAt] = useState<Record<string, number>>({});
  const [reindexing, setReindexing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [rawUrl, setRawUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [error, setError] = useState<string | null>(() => searchParams.get("uploadError"));
  const [uploadProgress, setUploadProgress] = useState<{ name: string; index: number; total: number; fraction: number } | null>(null);
  const [uploadIssues, setUploadIssues] = useState<{ name: string; message: string }[]>([]);
  const focusMaterialId = searchParams.get("material");
  const focusStart = Number(searchParams.get("start"));
  const focusEnd = Number(searchParams.get("end"));
  const focusQuote = searchParams.get("quote") ?? "";
  const focusKey = `${focusMaterialId ?? ""}:${focusStart}:${focusEnd}:${focusQuote}`;
  const focusSpan = useMemo(() => {
    if (activeId !== focusMaterialId || content?.text === undefined) return null;
    return resolveFocusSpan(content.text, focusStart, focusEnd, focusQuote);
  }, [activeId, content, focusEnd, focusMaterialId, focusQuote, focusStart]);

  const refresh = useCallback(() => {
    if (!user || !caseId) return;
    listMaterials(caseId)
      .then((list) => {
        setMaterials(list);
        setActiveId((prev) => {
          if (focusMaterialId && appliedFocusKeyRef.current !== focusKey && list.some((item) => item.id === focusMaterialId)) {
            appliedFocusKeyRef.current = focusKey;
            return focusMaterialId;
          }
          if (prev && list.some((item) => item.id === prev)) return prev;
          return list[0]?.id ?? null;
        });
      })
      .catch((e: Error) => setError(e.message));
  }, [caseId, focusKey, focusMaterialId, user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const patchLocalMaterial = useCallback((mid: string, patch: Partial<ApiMaterial>) => {
    setMaterials((prev) => prev?.map((m) => (m.id === mid ? { ...m, ...patch } : m)) ?? prev);
    setContent((prev) => (prev?.material.id === mid ? { ...prev, material: { ...prev.material, ...patch } } : prev));
  }, []);

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

  const serverProcessingIds = useMemo(() => materials?.filter((m) => m.status === "processing").map((m) => m.id).sort().join("|") ?? "", [materials]);

  useEffect(() => {
    if (!user || !caseId || (!serverProcessingIds && processingIds.size === 0)) return;
    const timer = window.setInterval(() => {
      refresh();
      const mid = activeIdRef.current;
      if (mid) {
        void getMaterialContent(mid)
          .then((next) => {
            if (activeIdRef.current === mid) setContent(next);
          })
          .catch((e: Error) => {
            if (activeIdRef.current === mid) setError(e.message);
          });
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [caseId, processingIds.size, refresh, serverProcessingIds, user]);

  useEffect(() => {
    if (serverProcessingIds || processingIds.size > 0) {
      const timer = window.setInterval(() => setNow(Date.now()), 1000);
      return () => window.clearInterval(timer);
    }
  }, [processingIds.size, serverProcessingIds]);

  const handleFiles = async (fileList: FileList | null) => {
    if (!user || !caseId || !canManage || !fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    setBusy(true);
    setError(null);
    setUploadIssues([]);
    // 逐个文件直传字节（二期 §4.6，绕 25MB base64 上限）；单个失败不拖垮整批，收集后单列。
    const issues: { name: string; message: string }[] = [];
    let firstOk: string | null = null;
    try {
      if (files.length > 1) {
        try {
          setUploadProgress({ name: "整批素材", index: 0, total: files.length, fraction: 0 });
          const uploaded = await uploadMaterialsBatch(caseId, files, (file, index, total) =>
            setUploadProgress({ name: file.name, index, total, fraction: index / total }),
          );
          firstOk = uploaded[0]?.id ?? null;
        } catch (e) {
          issues.push({ name: `整批上传（${files.length} 个文件）`, message: (e as Error).message });
        }
      } else {
        const file = files[0];
        setUploadProgress({ name: file.name, index: 1, total: 1, fraction: 0 });
        try {
          const uploaded = await uploadMaterial(caseId, file, (fraction) =>
            setUploadProgress({ name: file.name, index: 1, total: 1, fraction }),
          );
          firstOk = uploaded.id;
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
      refreshStatus();
      if (firstOk) setActiveId(firstOk);
    }
  };

  // 重建稠密索引（embed 端点恢复后）；完成后刷新列表与阅读区。
  const handleReindex = async (mid: string) => {
    if (!user || !caseId || !canManage || reindexing) return;
    setReindexing(true);
    setError(null);
    try {
      await reindexMaterial(caseId, mid);
      refresh();
      refreshStatus();
      if (activeIdRef.current === mid) {
        const next = await getMaterialContent(mid);
        if (activeIdRef.current === mid) setContent(next);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReindexing(false);
    }
  };

  // 删除素材（清理落盘 + 从专题摘除）；删当前选中则清空阅读区，列表回落首项。
  const handleDelete = async (mid: string) => {
    if (!user || !caseId || !canManage || deleting) return;
    if (!window.confirm("确认删除该素材？将一并清除其解析文本、片段与检索索引，此操作不可恢复。")) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteMaterial(caseId, mid);
      if (activeIdRef.current === mid) {
        setActiveId(null);
        setContent(null);
      }
      refresh();
      refreshStatus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  // 显式加工媒体素材（二期 P2.3a）；完成后刷新列表与阅读区。
  const handleProcess = async (mid: string) => {
    if (!user || !caseId || !canManage || processingIds.has(mid)) return;
    setProcessingIds((prev) => new Set(prev).add(mid));
    setProcessStartedAt((prev) => ({ ...prev, [mid]: Date.now() }));
    patchLocalMaterial(mid, { status: "processing", note: "加工中：请求已发送，等待后端接手" });
    setError(null);
    try {
      const material = await processMaterial(caseId, mid);
      patchLocalMaterial(mid, material);
      refresh();
      refreshStatus();
      if (activeIdRef.current === mid) {
        const next = await getMaterialContent(mid);
        if (activeIdRef.current === mid) setContent(next);
      }
    } catch (e) {
      setError((e as Error).message);
      refresh();
      if (activeIdRef.current === mid) {
        void getMaterialContent(mid)
          .then((next) => {
            if (activeIdRef.current === mid) setContent(next);
          })
          .catch(() => undefined);
      }
    } finally {
      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(mid);
        return next;
      });
      setProcessStartedAt((prev) => {
        const next = { ...prev };
        delete next[mid];
        return next;
      });
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

  const activeProcessing = content ? content.material.status === "processing" || processingIds.has(content.material.id) : false;
  const activeElapsed = content ? elapsedLabel(processStartedAt[content.material.id], now) : "进行中";
  const filteredMaterials = useMemo(() => {
    if (!materials) return null;
    const q = materialFilter.trim().toLowerCase();
    if (!q) return materials;
    return materials.filter((m) => {
      const displayMaterial = processingIds.has(m.id) ? { ...m, status: "processing" as const, note: m.note ?? "加工中：请求已发送，等待后端接手" } : m;
      return [
        m.filename,
        m.modality,
        MODALITY_LABELS[m.modality],
        displayMaterial.status,
        materialListStatus(displayMaterial).text,
        displayMaterial.note ?? "",
      ].some((value) => value.toLowerCase().includes(q));
    });
  }, [materialFilter, materials, processingIds]);

  return (
    <div className="materials-layout">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        disabled={!canManage}
        style={{ display: "none" }}
        onChange={(e) => void handleFiles(e.target.files)}
      />

      {/* 素材侧栏 */}
      <div className="materials-sidebar">
        <div style={{ padding: "12px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: "12px", fontWeight: "700", color: "var(--text-muted)", textTransform: "uppercase" }}>
            线索素材 ({materials ? (materialFilter.trim() ? `${filteredMaterials?.length ?? 0}/${materials.length}` : materials.length) : 0})
          </span>
          {canManage ? (
            <button type="button" className="btn btn--primary" style={{ padding: "4px 10px", fontSize: "11px" }} disabled={busy} onClick={() => fileInputRef.current?.click()}>
              {busy ? "汇入中…" : "+ 汇入"}
            </button>
          ) : null}
        </div>
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
          <input
            className="input-text"
            style={{ padding: "8px 10px", fontSize: "12px" }}
            value={materialFilter}
            onChange={(e) => setMaterialFilter(e.target.value)}
            placeholder="按文件名 / 类型 / 状态 / 备注过滤"
          />
        </div>

        {error ? <div style={{ padding: "12px", fontSize: "12px", color: "var(--danger-light)" }}>{error}</div> : null}

        {uploadProgress ? (
          <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ fontSize: "11px", color: "var(--text-dim)", marginBottom: "5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {uploadProgress.fraction >= 1
                ? `上传完成，正在登记素材… ${uploadProgress.index}/${uploadProgress.total} — ${uploadProgress.name}`
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
            素材上传存在问题（已成功的项目仍保留）：
            {uploadIssues.map((it, i) => (
              <div key={i} style={{ marginTop: "2px" }}>· {it.name}：{it.message}</div>
            ))}
          </div>
        ) : null}

        {materials === null ? (
          <div style={{ padding: "16px", fontSize: "13px", color: "var(--text-dim)" }}>加载中…</div>
        ) : materials.length === 0 ? (
          <div style={{ padding: "16px", fontSize: "13px", color: "var(--text-dim)", lineHeight: "1.6" }}>
            暂无素材。点击「+ 汇入」上传线索：文档会尝试自动解析并建立检索片段；音频、视频与图片汇入后可点击「开始加工」进行转写与识别，需对应识别能力已配置。
          </div>
        ) : filteredMaterials?.length === 0 ? (
          <div style={{ padding: "16px", fontSize: "13px", color: "var(--text-dim)", lineHeight: "1.6" }}>
            无匹配素材。可按文件名、类型、加工状态或备注继续缩小范围。
          </div>
        ) : (
          filteredMaterials!.map((m) => {
            const displayMaterial = processingIds.has(m.id) ? { ...m, status: "processing" as const, note: m.note ?? "加工中：请求已发送，等待后端接手" } : m;
            const s = materialListStatus(displayMaterial);
            return (
              <button
                type="button"
                key={m.id}
                className={`materials-item materials-item--${m.modality} materials-item--${displayMaterial.status} ${activeId === m.id ? "active" : ""}`}
                onClick={() => setActiveId(m.id)}
              >
                <div className="materials-item__main">
                  <span className={`materials-chip materials-chip--${m.modality}`}>{MODALITY_LABELS[m.modality]}</span>
                  <div className="materials-item__title">{m.filename}</div>
                </div>
                <div className="materials-item__meta">
                  <span>{m.format.toUpperCase()} · {formatSize(m.size)}</span>
                  <span style={{ color: s.color }}>
                    {s.text}
                    {displayMaterial.status === "done" && m.chunk_count !== undefined ? ` · ${m.chunk_count} 个片段` : ""}
                  </span>
                </div>
                {displayMaterial.status === "processing" ? (
                  <div className="material-progress material-progress--thin" role="progressbar" aria-valuetext="加工中" aria-label="加工进度">
                    <div />
                  </div>
                ) : null}
              </button>
            );
          })
        )}
      </div>

      {/* 内容阅读区 */}
      <div className="materials-viewer">
        {!content ? (
          <div style={{ padding: "32px", color: "var(--text-dim)", fontSize: "14px" }}>
            {materials && materials.length === 0 ? "汇入素材后，可在此查看解析后的原文与可引用片段。" : "选择左侧素材查看内容。"}
          </div>
        ) : (
          <>
            <div className="materials-viewer__header">
              <div className="materials-viewer__top">
                <div className="materials-viewer__identity">
                  <span className={`materials-chip materials-chip--${content.material.modality}`}>{MODALITY_LABELS[content.material.modality]}</span>
                  <div className="materials-viewer__title">
                  <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                  </svg>
                    <span>{content.material.filename}</span>
                  </div>
                </div>
                <div className="materials-viewer__actions">
                  {canManage && content.material.status === "done" ? (
                    <button
                      type="button"
                      className="btn"
                      style={{ padding: "4px 10px", fontSize: "11px", display: "inline-flex", alignItems: "center", gap: "4px" }}
                      disabled={reindexing || deleting || activeProcessing}
                      onClick={() => void handleReindex(content.material.id)}
                      title="重新生成该素材的语义检索索引"
                    >
                      <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                      </svg>
                      {reindexing ? "重建中…" : "重建索引"}
                    </button>
                  ) : null}
                  {canManage ? (
                    <button
                      type="button"
                      className="btn btn--danger"
                      style={{ padding: "4px 10px", fontSize: "11px", display: "inline-flex", alignItems: "center", gap: "4px" }}
                      disabled={deleting || reindexing || activeProcessing}
                      onClick={() => void handleDelete(content.material.id)}
                    >
                      <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>
                      </svg>
                      {deleting ? "删除中…" : "删除"}
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="materials-viewer__meta">
                <span>格式 <strong>{content.material.format.toUpperCase()}</strong></span>
                <span>大小 <strong>{formatSize(content.material.size)}</strong></span>
                <span>汇入 <strong>{content.material.ingested_at.replace("T", " ").slice(0, 19)}</strong></span>
                {content.chunkCount !== undefined ? <span>片段 <strong>{content.chunkCount}</strong></span> : null}
                <span style={{ color: materialListStatus(content.material).color }}>{materialListStatus(content.material).text}</span>
              </div>
            </div>

            <div className="materials-viewer__body">
              {isMediaModality(content.material.modality) ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                    {canManage ? (
                      <button
                        type="button"
                        className="btn btn--primary"
                        style={{ padding: "6px 14px", fontSize: "12px" }}
                        onClick={() => void handleProcess(content.material.id)}
                        disabled={activeProcessing || deleting || reindexing}
                      >
                      {activeProcessing ? (
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
                      ) : needsMaterialConfig(content.material.note) ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                          <svg className="icon-svg" style={{ width: "12px", height: "12px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="5 3 19 12 5 21 5 3"/>
                          </svg>
                          配置后开始
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
                    ) : null}
                    <span style={{ fontSize: "12px", color: "var(--text-dim)" }}>{mediaStatusText(content)}</span>
                  </div>
                  {activeProcessing ? (
                    <div className="material-process" role="status" aria-live="polite" aria-busy="true">
                      <div className="material-process__head">
                        <strong>{mediaStatusText(content)}</strong>
                        <span>{activeElapsed}</span>
                      </div>
                      <div className="material-progress" role="progressbar" aria-valuetext={mediaStatusText(content)} aria-label="加工进度">
                        <div />
                      </div>
                    </div>
                  ) : null}

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
                    <div style={{ background: "rgba(252, 211, 77, 0.04)", border: "1px solid rgba(252, 211, 77, 0.2)", borderRadius: "var(--radius)", padding: "8px 12px", color: "var(--warn-light)", fontSize: "12px", lineHeight: "1.6", marginBottom: "10px", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <svg className="icon-svg" style={{ color: "var(--warn-light)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                      <span>{content.material.note}</span>
                    </div>
                  ) : null}
                  <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit", fontSize: "13px", lineHeight: "1.7", color: "var(--text)", margin: 0 }}>
                    {focusSpan ? <HighlightedText text={content.text} start={focusSpan.start} end={focusSpan.end} /> : content.text}
                  </pre>
                </>
              ) : (
                <div style={{ background: "rgba(252, 211, 77, 0.04)", border: "1px solid rgba(252, 211, 77, 0.2)", borderRadius: "var(--radius)", padding: "16px", color: "var(--warn-light)", fontSize: "13px", lineHeight: "1.6" }}>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                    <svg className="icon-svg" style={{ color: "var(--warn-light)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    <strong>{content.note ?? "该素材尚未加工完成。"}</strong>
                  </div>
                  <div style={{ marginTop: "8px", color: "var(--text-dim)" }}>
                    {isMediaModality(content.material.modality)
                      ? "点击上方「开始加工」，对音视频与图像进行转写与识别，生成可引用片段。"
                      : "该文档尚未生成可检索文本。请检查 liteparse/OCR 配置后重新上传，或上传文本版材料。"}
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

function HighlightedText({ text, start, end }: { text: string; start: number; end: number }) {
  const safeStart = Math.max(0, Math.min(start, text.length));
  const safeEnd = Math.max(safeStart, Math.min(end, text.length));
  return (
    <>
      {text.slice(0, safeStart)}
      <mark className="source-highlight">{text.slice(safeStart, safeEnd)}</mark>
      {text.slice(safeEnd)}
    </>
  );
}
