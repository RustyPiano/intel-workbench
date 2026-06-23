import { describe, expect, it } from "vitest";

import type { Chunk, Citation } from "../src/domain/types.js";
import { validateCitationIntegrity } from "../src/inquiry/citation.js";
import { sha256 } from "../src/util/hash.js";

function chunk(text: string): Chunk {
  return {
    chunk_id: "m1#1",
    material_id: "m1",
    modality: "doc",
    locator: { paragraph: 1 },
    text,
    content_hash: sha256(text),
  };
}

function citationFor(c: Chunk, quote: string, start: number): Citation {
  return {
    material_id: c.material_id,
    material_name: "intel.txt",
    modality: "doc",
    locator: c.locator,
    snippet: quote,
    confidence: 0.9,
    content_hash: c.content_hash,
    quote,
    quote_char_start: start,
    quote_char_end: start + quote.length,
    quote_hash: sha256(quote),
  };
}

describe("validateCitationIntegrity", () => {
  it("rejects a declared span when the quote only matches elsewhere in the chunk", () => {
    const c = chunk("alpha beta alpha");
    const citation = citationFor(c, "alpha", 6);

    expect(validateCitationIntegrity(citation, [c])).toEqual({
      validChunk: true,
      validSpan: false,
      missingSpan: false,
    });
  });

  it("treats a current chunk citation without quote_hash as missing span", () => {
    const c = chunk("目标甲在码头出现。");
    const { quote_hash: _quoteHash, ...citation } = citationFor(c, "目标甲", 0);

    expect(validateCitationIntegrity(citation, [c])).toEqual({
      validChunk: true,
      validSpan: false,
      missingSpan: true,
    });
  });
});
