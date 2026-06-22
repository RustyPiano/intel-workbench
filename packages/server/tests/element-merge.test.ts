import { describe, expect, it } from "vitest";

import type { Citation, Element, ElementType } from "../src/domain/types.js";
import { mergeElements } from "../src/analysis/element-merge.js";

function citation(content_hash: string, locator: Citation["locator"] = { page: 1 }): Citation {
  return {
    material_id: "m1",
    material_name: "intel.txt",
    modality: "doc",
    locator,
    snippet: content_hash,
    confidence: 0.9,
    content_hash,
  };
}

function element(name: string, mentions: Citation[], aliases: string[] = [], type: ElementType = "person"): Element {
  return {
    id: `src-${name}`,
    type,
    name,
    aliases,
    mentions,
    freq: mentions.length,
  };
}

describe("mergeElements", () => {
  it("merges same type and normalized name across groups", () => {
    const a = citation("h1", { page: 1 });
    const b = citation("h2", { page: 2 });

    const merged = mergeElements([
      [element("Alice", [a], ["A", "Agent Alice"])],
      [element("  alice  ", [b], ["A", "Al"])],
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ type: "person", name: "Alice", aliases: ["A", "Agent Alice", "Al"], freq: 2 });
    expect(merged[0].mentions).toEqual([a, b]);
  });

  it("dedupes identical mentions by content hash and locator", () => {
    const mention = citation("same", { paragraph: 3 });

    const merged = mergeElements([
      [element("Alice", [mention])],
      [element("Alice", [mention])],
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].mentions).toEqual([mention]);
    expect(merged[0].freq).toBe(1);
  });

  it("keeps different names as separate elements", () => {
    const merged = mergeElements([[element("Alice", [citation("h1")]), element("Bob", [citation("h2")])]]);

    expect(merged.map((el) => el.name).sort()).toEqual(["Alice", "Bob"]);
  });

  it("drops aliases that normalize to the element name", () => {
    const merged = mergeElements([[element("Alice Smith", [citation("h1")], [" alice   smith ", "A. Smith"])]]);

    expect(merged[0].aliases).toEqual(["A. Smith"]);
  });

  it("produces deterministic ids for identical input", () => {
    const groups = [[element("Alice", [citation("h1")])]];

    expect(mergeElements(groups)[0].id).toBe(mergeElements(groups)[0].id);
  });

  it("orders output by frequency descending before lower frequency elements", () => {
    const merged = mergeElements([
      [element("Bob", [citation("b1")])],
      [element("Alice", [citation("a1"), citation("a2", { page: 2 })])],
    ]);

    expect(merged.map((el) => el.name)).toEqual(["Alice", "Bob"]);
  });
});
