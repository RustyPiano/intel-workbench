import type { Citation, Element, ElementGraph, ElementGraphEdge, ElementGraphNode, TimelinePoint } from "../domain/types.js";

const MAX_NODES = 40;
const MAX_RELATED = 20;

/**
 * 共现 = 同 chunk(content_hash) 出现；确定性、可溯源、无 LLM。
 *
 * v1 选择 chunk 级共现而非 material 级共现：material 级信号过宽，容易把同一素材内
 * 距离很远的要素误连。圆形布局由前端负责；多栏时间线、复杂相对时间解析暂不展开。
 */

function inRange(value: number | undefined, min: number, max: number): number {
  return value !== undefined && value >= min && value <= max ? value : 0;
}

function parseIntPart(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function parseTimeParts(text: string): { hour: number; minute: number } {
  const colon = text.match(/(?:^|\D)(\d{1,2}):(\d{1,2})(?::\d{1,2})?(?!\d)/u);
  const chinese = colon ? null : text.match(/(?:^|\D)(\d{1,2})\s*时\s*(\d{1,2})\s*分?/u);
  const match = colon ?? chinese;
  if (!match) return { hour: 0, minute: 0 };
  return {
    hour: inRange(parseIntPart(match[1]), 0, 23),
    minute: inRange(parseIntPart(match[2]), 0, 59),
  };
}

export function parseTimeKey(label: string): number | null {
  // 年须为独立四位数：前为串首/非数字，后不接数字或拉丁字母（拒 "型号2026A" 之类把编号误判为年）。
  const yearMatch = /(^|\D)(\d{4})(?![\dA-Za-z])/u.exec(label);
  if (!yearMatch) return null;
  const yearIndex = yearMatch.index + yearMatch[1].length;
  if (/\d{1,2}\s*(?:月|日|号)|\d{1,2}\s*[-/.]\s*\d{1,2}/u.test(label.slice(0, yearIndex))) return null;
  const year = Number(yearMatch[2]);
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return null;

  const afterYear = label.slice(yearIndex + 4);
  let month = 0;
  let day = 0;
  let dateEnd = yearIndex + 4;

  const chineseDate = /^\s*年\s*(?:(\d{1,2})\s*月\s*(?:(\d{1,2})\s*(?:日|号)?)?)?/u.exec(afterYear);
  if (chineseDate) {
    month = inRange(parseIntPart(chineseDate[1]), 1, 12);
    day = inRange(parseIntPart(chineseDate[2]), 1, 31);
    dateEnd += chineseDate[0].length;
  } else {
    const numericDate = /^\s*[-/.]\s*(\d{1,2})(?:\s*[-/.]\s*(\d{1,2}))?/u.exec(afterYear);
    if (numericDate) {
      month = inRange(parseIntPart(numericDate[1]), 1, 12);
      day = inRange(parseIntPart(numericDate[2]), 1, 31);
      dateEnd += numericDate[0].length;
    }
  }

  const { hour, minute } = parseTimeParts(label.slice(dateEnd));
  return year * 1e8 + month * 1e6 + day * 1e4 + hour * 1e2 + minute;
}

function citationListByHash(mentions: Citation[]): Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const mention of mentions) {
    if (seen.has(mention.content_hash)) continue;
    seen.add(mention.content_hash);
    citations.push(mention);
  }
  return citations;
}

function edgeKey(source: string, target: string): string {
  return `${source}__${target}`;
}

export function buildElementGraph(elements: Element[]): ElementGraph {
  const citeByHash = new Map<string, Citation>();
  const chunkToEls = new Map<string, string[]>();
  const elementById = new Map(elements.map((element) => [element.id, element]));

  for (const element of elements) {
    const hashesForElement = new Set<string>();
    for (const mention of element.mentions) {
      if (!citeByHash.has(mention.content_hash)) citeByHash.set(mention.content_hash, mention);
      hashesForElement.add(mention.content_hash);
    }
    for (const hash of hashesForElement) {
      const ids = chunkToEls.get(hash) ?? [];
      ids.push(element.id);
      chunkToEls.set(hash, ids);
    }
  }

  const kept = [...elements]
    .sort((a, b) => b.freq - a.freq || a.name.localeCompare(b.name))
    .slice(0, MAX_NODES);
  const truncated = elements.length > MAX_NODES;
  const keptIds = new Set(kept.map((element) => element.id));
  const nodes: ElementGraphNode[] = kept.map((element) => ({
    id: element.id,
    name: element.name,
    type: element.type,
    freq: element.freq,
    degree: 0,
  }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edgeMap = new Map<string, ElementGraphEdge>();

  for (const [hash, ids] of chunkToEls) {
    const shared = [...new Set(ids)].filter((id) => keptIds.has(id)).sort((a, b) => a.localeCompare(b));
    for (let i = 0; i < shared.length; i += 1) {
      for (let j = i + 1; j < shared.length; j += 1) {
        const source = shared[i];
        const target = shared[j];
        const key = edgeKey(source, target);
        const edge = edgeMap.get(key) ?? { source, target, weight: 0, citations: [] };
        edge.weight += 1;
        const citation = citeByHash.get(hash);
        if (citation) edge.citations.push(citation);
        edgeMap.set(key, edge);
      }
    }
  }

  const edges = [...edgeMap.values()].sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  for (const edge of edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (source) source.degree += 1;
    if (target) target.degree += 1;
  }

  const timeline: TimelinePoint[] = elements
    .filter((element) => element.type === "time")
    .map((element) => {
      const relatedIds = new Set<string>();
      for (const hash of new Set(element.mentions.map((mention) => mention.content_hash))) {
        for (const id of chunkToEls.get(hash) ?? []) {
          const related = elementById.get(id);
          if (id !== element.id && related && related.type !== "time") relatedIds.add(id);
        }
      }
      const related = [...relatedIds]
        .map((id) => elementById.get(id))
        .filter((relatedElement): relatedElement is Element => Boolean(relatedElement))
        .sort((a, b) => b.freq - a.freq || a.name.localeCompare(b.name))
        .slice(0, MAX_RELATED)
        .map((relatedElement) => ({ id: relatedElement.id, name: relatedElement.name, type: relatedElement.type }));
      return {
        id: element.id,
        label: element.name,
        sortKey: parseTimeKey(element.name),
        related,
        citations: citationListByHash(element.mentions),
      };
    })
    .sort((a, b) => {
      if (a.sortKey !== null && b.sortKey !== null) return a.sortKey - b.sortKey || a.label.localeCompare(b.label);
      if (a.sortKey !== null) return -1;
      if (b.sortKey !== null) return 1;
      return a.label.localeCompare(b.label);
    });
  const anchored = timeline.some((point) => point.sortKey !== null);

  return { nodes, edges, timeline, anchored, truncated };
}
