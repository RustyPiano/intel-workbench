import { describe, expect, it } from "vitest";

import { buildElementGraph, parseTimeKey } from "../src/analysis/element-graph.js";
import type { Citation, Element, ElementType } from "../src/domain/types.js";

function cite(contentHash: string, snippet = contentHash): Citation {
  return {
    material_id: "m1",
    material_name: "source.txt",
    modality: "doc",
    locator: { paragraph: 1 },
    snippet,
    confidence: 1,
    content_hash: contentHash,
  };
}

function el(id: string, name: string, type: ElementType, hashes: string[]): Element {
  return {
    id,
    name,
    type,
    aliases: [],
    mentions: hashes.map((hash) => cite(hash)),
    freq: hashes.length,
  };
}

describe("parseTimeKey", () => {
  it.each([
    ["2026年6月1日", 202606010000],
    ["2026-06-01", 202606010000],
    ["2026/6/1 14:30", 202606011430],
    ["2026年6月", 202606000000],
    ["2026年", 202600000000],
    ["凌晨3点", null],
    ["近期", null],
  ])("%s -> %s", (label, expected) => {
    expect(parseTimeKey(label)).toBe(expected);
  });

  it("keeps partial dates ordered before later precise dates", () => {
    expect(parseTimeKey("2026年5月")!).toBeLessThan(parseTimeKey("2026年6月")!);
    expect(parseTimeKey("2026年6月")!).toBeLessThan(parseTimeKey("2026年6月2日")!);
  });

  it("rejects non-year-first date forms", () => {
    expect(parseTimeKey("6月1日2026年")).toBeNull();
  });

  it("rejects identifiers that merely contain a 4-digit run", () => {
    expect(parseTimeKey("型号2026A")).toBeNull();
    expect(parseTimeKey("13800002026")).toBeNull();
  });
});

describe("buildElementGraph", () => {
  it("creates one edge when two elements share one chunk", () => {
    const graph = buildElementGraph([
      el("person-a", "甲", "person", ["h1"]),
      el("org-b", "乙", "org", ["h1"]),
    ]);

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ source: "org-b", target: "person-a", weight: 1 });
    expect(graph.edges[0].citations).toHaveLength(1);
    expect(Object.fromEntries(graph.nodes.map((node) => [node.id, node.degree]))).toEqual({
      "person-a": 1,
      "org-b": 1,
    });
  });

  it("counts two distinct shared chunks as edge weight two", () => {
    const graph = buildElementGraph([
      el("a", "甲", "person", ["h1", "h2"]),
      el("b", "乙", "org", ["h1", "h2"]),
    ]);

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].weight).toBe(2);
    expect(graph.edges[0].citations).toHaveLength(2);
  });

  it("keeps isolated elements with degree zero and no edges", () => {
    const graph = buildElementGraph([el("a", "甲", "person", ["h1"])]);

    expect(graph.edges).toEqual([]);
    expect(graph.nodes).toMatchObject([{ id: "a", degree: 0 }]);
  });

  it("adds timeline related elements that share chunks with a time element", () => {
    const graph = buildElementGraph([
      el("time-1", "2026年6月1日", "time", ["h1"]),
      el("person-a", "甲", "person", ["h1"]),
    ]);

    expect(graph.timeline).toHaveLength(1);
    expect(graph.timeline[0]).toMatchObject({ id: "time-1", label: "2026年6月1日", sortKey: 202606010000 });
    expect(graph.timeline[0].related).toEqual([{ id: "person-a", name: "甲", type: "person" }]);
  });

  it("sets anchored true only when at least one time element is parseable", () => {
    expect(buildElementGraph([el("time-1", "2026年6月1日", "time", ["h1"])]).anchored).toBe(true);
    expect(buildElementGraph([el("time-2", "近期", "time", ["h1"])]).anchored).toBe(false);
  });

  it("dedupes repeated content_hash mentions per element before edge counting", () => {
    const graph = buildElementGraph([
      el("a", "甲", "person", ["h1", "h1"]),
      el("b", "乙", "org", ["h1"]),
    ]);

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].weight).toBe(1);
    expect(graph.edges[0].citations).toHaveLength(1);
  });
});
