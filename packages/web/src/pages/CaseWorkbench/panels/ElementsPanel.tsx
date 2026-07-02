import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  getElementGraph,
  listElements,
  type ApiCitation,
  type ApiClaim,
  type ApiElement,
  type ElementGraph,
  type ElementType,
  type TimelinePoint,
} from "../../../api";
import { useSession } from "../../../state/session";
import { CitationChips } from "../components/CitationChips";
import { FrameCiteView } from "../components/FrameCiteView";
import {
  compactElementName,
  ELEMENT_TYPE_LABELS,
  ELEMENT_TYPES,
  GRAPH_EDGE_STEP,
  GRAPH_MIN_EDGES,
  mentionSources,
  TYPE_COLORS,
} from "../components/helpers";
import { useExtractionJob } from "../hooks/useExtractionJob";

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

export function ElementsPanel() {
  const { id: caseId } = useParams<{ id: string }>();
  const { user } = useSession();
  const [elements, setElements] = useState<ApiElement[] | null>(null);
  const [view, setView] = useState<"list" | "graph" | "timeline">("list");
  const [activeCat, setActiveCat] = useState<ElementType | "all">("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reloadElements = useCallback(() => {
    if (!user || !caseId) return;
    let alive = true;
    listElements(caseId)
      .then((els) => alive && setElements(els))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [user, caseId]);

  useEffect(() => {
    return reloadElements();
  }, [reloadElements]);

  const onElementsDone = useCallback(() => {
    void reloadElements();
  }, [reloadElements]);
  const { job, error: jobError, start: startExtraction, cancel: cancelExtraction } = useExtractionJob(caseId ?? "", "elements", onElementsDone);

  const handleExtract = async () => {
    if (!user || !caseId) return;
    setError(null);
    startExtraction();
  };

  const all = elements ?? [];
  const running = job?.state === "running";
  const total = job?.progress.total ?? 0;
  const done = job?.progress.done ?? 0;
  const progressWidth = running && total > 0 ? `${Math.min(100, Math.round((done / total) * 100))}%` : "38%";
  const filtered = all.filter((e) => {
    const matchCat = activeCat === "all" || e.type === activeCat;
    const q = search.toLowerCase();
    const matchSearch = !q || e.name.toLowerCase().includes(q) || e.aliases.some((a) => a.toLowerCase().includes(q));
    return matchCat && matchSearch;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", minHeight: 0 }}>
      <div style={{ display: "inline-flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className={`btn ${view === "list" ? "btn--primary" : ""}`} style={{ padding: "6px 12px", fontSize: "12px" }} onClick={() => setView("list")}>
          要素列表
        </button>
        <button type="button" className={`btn ${view === "graph" ? "btn--primary" : ""}`} style={{ padding: "6px 12px", fontSize: "12px" }} onClick={() => setView("graph")}>
          关系网络
        </button>
        <button type="button" className={`btn ${view === "timeline" ? "btn--primary" : ""}`} style={{ padding: "6px 12px", fontSize: "12px" }} onClick={() => setView("timeline")}>
          时间线
        </button>
      </div>

      {view === "list" ? (
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
              <button type="button" className="btn btn--primary" style={{ whiteSpace: "nowrap" }} onClick={handleExtract} disabled={running}>
                {running ? "抽取中…" : elements && elements.length > 0 ? "重新抽取" : "提取要素"}
              </button>
            </div>

            {error ? <div style={{ color: "var(--danger-light)", fontSize: "12px" }}>{error}</div> : null}
            {jobError ? <div style={{ color: "var(--danger-light)", fontSize: "12px" }}>{jobError}</div> : null}
            {running ? (
              <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                <div style={{ flex: 1, height: "6px", borderRadius: "999px", background: "rgba(148, 163, 184, 0.18)", overflow: "hidden" }}>
                  <div style={{ width: progressWidth, height: "100%", background: "var(--accent)", transition: "width 0.2s ease" }} />
                </div>
                <span style={{ color: "var(--text-muted)", fontSize: "12px", whiteSpace: "nowrap" }}>
                  抽取中 · 批次 {done}/{total}
                </span>
                <button type="button" className="btn" style={{ padding: "4px 10px", fontSize: "12px" }} onClick={cancelExtraction} disabled={!running}>
                  取消
                </button>
              </div>
            ) : job?.state === "error" ? (
              <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>{job.error ?? "任务失败"}</div>
            ) : job?.state === "cancelled" ? (
              <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>已取消</div>
            ) : null}

            <div className="elements-main table-scroll">
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
                      <td data-label="要素名称" style={{ fontWeight: "700" }}>{item.name}</td>
                      <td data-label="类型">
                        <span className={`entity-tag entity-tag--${item.type}`}>{ELEMENT_TYPE_LABELS[item.type]}</span>
                      </td>
                      <td data-label="提及频次" style={{ fontFamily: "monospace", fontSize: "14px", fontWeight: "600" }}>{item.freq}</td>
                      <td
                        data-label="出处关联"
                        style={{ fontSize: "12px", color: "var(--accent-light)", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        title={item.mentions.map((m) => `${m.material_name}${m.locator.paragraph ? ` 第${m.locator.paragraph}段` : ""}：${m.snippet}`).join("\n")}
                      >
                        {mentionSources(item)}
                      </td>
                      <td data-label="别名" style={{ color: "var(--text-dim)", fontSize: "13px" }}>{item.aliases.join("、") || "—"}</td>
                    </tr>
                  ))}
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ textAlign: "center", color: "var(--text-muted)", padding: "40px", lineHeight: "1.7" }}>
                        {elements === null
                          ? "加载中…"
                          : all.length === 0
                            ? "尚未抽取要素。点击「提取要素」从已加工素材中抽取人物/组织/地点/事件等（需文本解析能力已配置）。每个要素都会绑定 to 素材出处。"
                            : "无匹配的要素。"}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : view === "graph" ? (
        <ElementGraphView caseId={caseId!} />
      ) : (
        <ElementTimelineView caseId={caseId!} />
      )}
    </div>
  );
}

function ElementGraphView({ caseId }: { caseId: string }) {
  const [graph, setGraph] = useState<ElementGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);
  const [frameCite, setFrameCite] = useState<ApiCitation | null>(null);
  const [edgeLimit, setEdgeLimit] = useState(GRAPH_MIN_EDGES);
  const edgeDetailRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    setGraph(null);
    setError(null);
    setSelectedNodeId(null);
    setSelectedEdgeKey(null);
    setFrameCite(null);
    setEdgeLimit(GRAPH_MIN_EDGES);
    getElementGraph(caseId)
      .then((next) => alive && setGraph(next))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [caseId]);

  useEffect(() => {
    if (!selectedEdgeKey) return;
    const timer = window.setTimeout(() => {
      edgeDetailRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedEdgeKey]);

  if (error) return <div style={{ color: "var(--danger-light)", fontSize: "12px" }}>{error}</div>;
  if (!graph) return <div style={{ color: "var(--text-muted)", padding: "40px", textAlign: "center" }}>加载中…</div>;
  if (graph.nodes.length === 0) {
    return (
      <div style={{ color: "var(--text-muted)", padding: "40px", textAlign: "center", lineHeight: "1.7" }}>
        尚未抽取要素。请先在「要素列表」抽取要素。
      </div>
    );
  }

  const visibleNodes = graph.nodes
    .filter((node) => node.degree >= 1)
    .sort((a, b) => b.degree - a.degree || b.freq - a.freq || a.name.localeCompare(b.name));
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const focusNodeId = selectedNodeId ?? visibleNodes[0]?.id ?? null;
  const focusNode = focusNodeId ? nodeById.get(focusNodeId) ?? null : null;
  const focusEdgesAll = focusNodeId
    ? graph.edges
      .filter((edge) => edge.source === focusNodeId || edge.target === focusNodeId)
      .sort((a, b) => b.weight - a.weight)
    : [];
  const focusEdges = focusEdgesAll.slice(0, edgeLimit);
  const canShowMoreEdges = edgeLimit < focusEdgesAll.length;
  const neighborNodes = focusEdges
    .map((edge) => nodeById.get(edge.source === focusNodeId ? edge.target : edge.source))
    .filter((node): node is NonNullable<typeof node> => Boolean(node));
  const positions = new Map<string, { x: number; y: number }>();
  if (focusNode) positions.set(focusNode.id, { x: 410, y: 310 });
  neighborNodes.forEach((node, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(neighborNodes.length, 1);
    positions.set(node.id, { x: 410 + Math.cos(angle) * 290, y: 310 + Math.sin(angle) * 230 });
  });
  const selectedEdge = graph.edges.find((edge) => `${edge.source}__${edge.target}` === selectedEdgeKey) ?? null;
  const selectedClaim: ApiClaim | null = selectedEdge
    ? {
        text: `${nodeById.get(selectedEdge.source)?.name ?? selectedEdge.source} × ${nodeById.get(selectedEdge.target)?.name ?? selectedEdge.target}（共现 ${selectedEdge.weight} 次）`,
        type: "fact",
        status: "verified",
        citations: selectedEdge.citations,
      }
    : null;
  const topNodes = visibleNodes.slice(0, 12);
  const isolated = graph.nodes.filter((node) => node.degree === 0);

  return (
    <div className="element-graph">
      <section className="graph-help">
        <div>
          <div className="graph-help__title">关系网络怎么看</div>
          <p>这里展示“同一素材片段里一起出现过”的要素。粗线表示共现次数更多，只说明材料中经常一起被提到，不等于因果关系或已确认结论。</p>
        </div>
        <div className="graph-help__steps">
          <span>点一个点：看它关联哪些要素</span>
          <span>点一条线：看这组关系的出处证据</span>
          <span>回到素材：核对原文片段</span>
        </div>
      </section>

      <div className="graph-meta">
        <div className="graph-stats">
          <span><strong>{visibleNodes.length}</strong> 个联网要素</span>
          <span><strong>{graph.edges.length}</strong> 条共现关系</span>
          <span><strong>{isolated.length}</strong> 个孤立要素</span>
        </div>
        <div className="graph-legend" aria-label="要素类型图例">
          {ELEMENT_TYPES.map((type) => (
            <span key={type}>
              <i style={{ background: TYPE_COLORS[type] }} />
              {ELEMENT_TYPE_LABELS[type]}
            </span>
          ))}
        </div>
      </div>

      {graph.truncated ? <div style={{ color: "var(--warn-light)", fontSize: "12px" }}>为保持可读，仅展示频次最高的 40 个要素</div> : null}
      {visibleNodes.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: "13px", lineHeight: "1.7" }}>要素之间暂无共现关系（同一片段未同时出现）。下方列出全部要素。</div>
      ) : (
        <>
          <div className="graph-toolbar">
            <span>当前中心：{focusNode?.name ?? "—"} · 显示 {focusEdges.length}/{focusEdgesAll.length} 条关系</span>
            <div className="graph-toolbar__actions">
              {canShowMoreEdges ? (
                <button type="button" onClick={() => setEdgeLimit((value) => value + GRAPH_EDGE_STEP)}>
                  展开更多（+{Math.min(GRAPH_EDGE_STEP, focusEdgesAll.length - focusEdges.length)}）
                </button>
              ) : null}
              {edgeLimit > GRAPH_MIN_EDGES ? (
                <button type="button" onClick={() => setEdgeLimit(GRAPH_MIN_EDGES)}>
                  只看重点关系
                </button>
              ) : null}
              {selectedEdgeKey ? (
                <button type="button" onClick={() => setSelectedEdgeKey(null)}>
                  取消选中
                </button>
              ) : null}
            </div>
          </div>
          {selectedClaim ? (
            <div className="graph-selection graph-edge-detail" ref={edgeDetailRef}>
              <div className="graph-selection__head">
                <strong>{selectedClaim.text}</strong>
                <span>共现证据</span>
              </div>
              <CitationChips claim={selectedClaim} onFrame={setFrameCite} />
              <small>这些引用说明两个要素在同一片段中一起出现；是否构成有效判断，需要打开素材原文核对。</small>
            </div>
          ) : null}
          <div className="graph-focus-layout">
            <aside className="graph-node-list" aria-label="中心要素">
              <div className="graph-node-list__title">选择中心要素</div>
              <div className="graph-node-list__hint">优先列出连接最多、最适合先看的要素。</div>
              {topNodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  className={`graph-node-list__button ${focusNodeId === node.id ? "is-active" : ""}`}
                  onClick={() => {
                    setSelectedNodeId(node.id);
                    setSelectedEdgeKey(null);
                    setEdgeLimit(GRAPH_MIN_EDGES);
                  }}
                >
                  <span>{node.name}</span>
                  <small>{ELEMENT_TYPE_LABELS[node.type]} · {node.degree} 条关系 · 提及 {node.freq} 次</small>
                </button>
              ))}
            </aside>

            <div className="graph-canvas">
              {focusNode ? (
                <svg viewBox="0 0 820 620" className="graph-svg" role="img" aria-label={`${focusNode.name} 的共现关系网络`} onClick={() => setSelectedEdgeKey(null)}>
                  {focusEdges.map((edge) => {
                    const source = positions.get(edge.source);
                    const target = positions.get(edge.target);
                    if (!source || !target) return null;
                    const key = `${edge.source}__${edge.target}`;
                    const active = selectedEdgeKey === key;
                    return (
                      <line
                        key={key}
                        x1={source.x}
                        y1={source.y}
                        x2={target.x}
                        y2={target.y}
                        stroke={active ? "#facc15" : "#94a3b8"}
                        strokeWidth={2 + Math.min(edge.weight, 6)}
                        opacity={active ? 0.92 : 0.5}
                        strokeLinecap="round"
                        style={{ cursor: "pointer" }}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedEdgeKey(key);
                        }}
                      >
                        <title>{nodeById.get(edge.source)?.name ?? edge.source} 与 {nodeById.get(edge.target)?.name ?? edge.target} 共现 {edge.weight} 次</title>
                      </line>
                    );
                  })}
                  {neighborNodes.map((node) => {
                    const pos = positions.get(node.id);
                    if (!pos) return null;
                    const labelOnRight = pos.x >= 410;
                    return (
                      <g
                        key={node.id}
                        style={{ cursor: "pointer" }}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedNodeId(node.id);
                          setSelectedEdgeKey(null);
                          setEdgeLimit(GRAPH_MIN_EDGES);
                        }}
                      >
                        <circle cx={pos.x} cy={pos.y} r={8 + Math.min(node.freq, 7)} fill={TYPE_COLORS[node.type]} stroke="#0f172a" strokeWidth="2" />
                        <text
                          x={pos.x + (labelOnRight ? 18 : -18)}
                          y={pos.y + 4}
                          fill="#e5e7eb"
                          fontSize="12"
                          fontWeight="700"
                          textAnchor={labelOnRight ? "start" : "end"}
                        >
                          {compactElementName(node.name)}
                        </text>
                      </g>
                    );
                  })}
                  {focusNode ? (
                    <g>
                      <circle cx="410" cy="310" r={38} fill={TYPE_COLORS[focusNode.type]} stroke="#f8fafc" strokeWidth="2" />
                      <circle cx="410" cy="310" r={52} fill="none" stroke={TYPE_COLORS[focusNode.type]} strokeWidth="2" opacity="0.35" />
                      <text x="410" y="384" fill="#f8fafc" fontSize="15" fontWeight="800" textAnchor="middle">
                        {compactElementName(focusNode.name, 30)}
                      </text>
                      <text x="410" y="405" fill="#94a3b8" fontSize="12" textAnchor="middle">
                        中心要素 · {focusNode.degree} 条关系
                      </text>
                    </g>
                  ) : null}
                </svg>
              ) : null}
            </div>
          </div>
        </>
      )}

      {focusNode ? (
        <div className="graph-selection">
          <div className="graph-selection__head">
            <strong>{focusNode.name}</strong>
            <span className={`entity-tag entity-tag--${focusNode.type}`}>{ELEMENT_TYPE_LABELS[focusNode.type]}</span>
            <span>提及 {focusNode.freq} 次 · 连接 {focusNode.degree} 个要素</span>
          </div>
          <div className="graph-selection__links">
            {focusEdges.length > 0 ? focusEdges.map((edge) => {
              const otherId = edge.source === focusNode.id ? edge.target : edge.source;
              const other = nodeById.get(otherId);
              return (
                <button
                  key={`${edge.source}__${edge.target}`}
                  type="button"
                  onClick={() => {
                    setSelectedEdgeKey(`${edge.source}__${edge.target}`);
                  }}
                >
                  {other?.name ?? otherId} · 共现 {edge.weight} 次
                </button>
              );
            }) : <span>暂无共现关系。</span>}
          </div>
          <small>点击上面的关系可查看引用出处；关系网络只提示线索密度，结论仍需回到素材核验。</small>
        </div>
      ) : null}

      {isolated.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-muted)" }}>孤立要素（无共现）</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {isolated.map((node) => (
              <span key={node.id} className={`entity-tag entity-tag--${node.type}`}>
                {node.name}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {frameCite ? <FrameCiteView cite={frameCite} onClose={() => setFrameCite(null)} /> : null}
    </div>
  );
}

function TimelinePointRow({ point, accentBorder, onFrame }: { point: TimelinePoint; accentBorder: string; onFrame: (c: ApiCitation) => void }) {
  const claim: ApiClaim = { text: point.label, type: "fact", status: "verified", citations: point.citations };
  return (
    <div style={{ borderLeft: `2px solid ${accentBorder}`, padding: "8px 0 8px 14px", display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: 700 }}>
        <span style={{ color: TYPE_COLORS.time }}>{ELEMENT_TYPE_ICONS.time}</span>
        <span>{point.label}</span>
      </div>
      {point.related.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
          {point.related.map((item) => (
            <span key={item.id} className={`entity-tag entity-tag--${item.type}`}>
              {item.name}
            </span>
          ))}
        </div>
      ) : null}
      <div style={{ fontSize: "12px", color: "var(--text-dim)" }}>
        出处
        <CitationChips claim={claim} onFrame={onFrame} />
      </div>
    </div>
  );
}

function ElementTimelineView({ caseId }: { caseId: string }) {
  const [graph, setGraph] = useState<ElementGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameCite, setFrameCite] = useState<ApiCitation | null>(null);

  useEffect(() => {
    let alive = true;
    setGraph(null);
    setError(null);
    setFrameCite(null);
    getElementGraph(caseId)
      .then((next) => alive && setGraph(next))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [caseId]);

  if (error) return <div style={{ color: "var(--danger-light)", fontSize: "12px" }}>{error}</div>;
  if (!graph) return <div style={{ color: "var(--text-muted)", padding: "40px", textAlign: "center" }}>加载中…</div>;
  if (graph.timeline.length === 0) {
    return (
      <div style={{ background: "rgba(245, 158, 11, 0.08)", border: "1px solid rgba(245, 158, 11, 0.25)", borderRadius: "var(--radius)", padding: "16px", color: "var(--warn-light)", fontSize: "13px", lineHeight: "1.6" }}>
        无时间锚：本专题要素中未发现时间类要素。
      </div>
    );
  }

  const anchoredPoints = graph.timeline.filter((point) => point.sortKey !== null);
  const loosePoints = graph.timeline.filter((point) => point.sortKey === null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", minHeight: 0 }}>
      {!graph.anchored ? (
        <div style={{ background: "rgba(245, 158, 11, 0.08)", border: "1px solid rgba(245, 158, 11, 0.25)", borderRadius: "var(--radius)", padding: "12px", color: "var(--warn-light)", fontSize: "13px", lineHeight: "1.6" }}>
          时间信息不足，未能建立明确时序。
        </div>
      ) : null}

      {anchoredPoints.map((point) => (
        <TimelinePointRow key={point.id} point={point} accentBorder="var(--accent)" onFrame={setFrameCite} />
      ))}

      {loosePoints.length > 0 ? <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-muted)", paddingTop: anchoredPoints.length > 0 ? "8px" : 0 }}>无明确时序</div> : null}
      {loosePoints.map((point) => (
        <TimelinePointRow key={point.id} point={point} accentBorder="var(--border)" onFrame={setFrameCite} />
      ))}

      {frameCite ? <FrameCiteView cite={frameCite} onClose={() => setFrameCite(null)} /> : null}
    </div>
  );
}
