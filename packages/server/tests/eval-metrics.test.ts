import { describe, expect, it } from "vitest";

import { aggregateMetrics, mrrAtK, ndcgAtK, recallAtK } from "../eval/metrics.js";

describe("RAG eval metrics", () => {
  it("computes recall@k from retrieved relevant ids", () => {
    expect(recallAtK(["a", "b", "c", "d"], ["b", "d", "x"], 3)).toBeCloseTo(1 / 3);
    expect(recallAtK(["a", "b", "c", "d"], ["b", "d", "x"], 4)).toBeCloseTo(2 / 3);
  });

  it("computes reciprocal rank for the first relevant id within k", () => {
    expect(mrrAtK(["rel", "x", "y"], ["rel"], 5)).toBe(1);
    expect(mrrAtK(["x", "y", "rel", "z"], ["rel"], 5)).toBeCloseTo(1 / 3);
  });

  it("computes binary nDCG@k with standard log2 discounts", () => {
    const actual = ndcgAtK(["a", "b", "c"], ["b", "c"], 3);
    const expected = (1 / Math.log2(3) + 1 / Math.log2(4)) / (1 + 1 / Math.log2(3));
    expect(actual).toBeCloseTo(expected);
  });

  it("never exceeds 1 even when the ranking repeats a relevant id", () => {
    expect(ndcgAtK(["a", "a"], ["a"], 2)).toBeCloseTo(1);
    expect(ndcgAtK(["a", "a", "b"], ["a", "b"], 3)).toBeLessThanOrEqual(1);
  });

  it("returns zero when nothing relevant is found or relevant ids are beyond k", () => {
    expect(recallAtK(["a", "b"], ["x"], 10)).toBe(0);
    expect(mrrAtK(["a", "b", "rel"], ["rel"], 2)).toBe(0);
    expect(ndcgAtK(["a", "b", "rel"], ["rel"], 2)).toBe(0);
  });

  it("returns zero when there are no relevant ids", () => {
    expect(recallAtK(["a"], [], 10)).toBe(0);
    expect(mrrAtK(["a"], [], 10)).toBe(0);
    expect(ndcgAtK(["a"], [], 10)).toBe(0);
  });

  it("averages requested metrics across queries", () => {
    const rows = [
      { ranked: ["a", "b", "c"], relevant: ["a"] },
      { ranked: ["x", "y", "z"], relevant: ["z"] },
      { ranked: ["m", "n"], relevant: ["q"] },
    ];

    expect(aggregateMetrics(rows, [1, 3])).toEqual({
      recallAt1: (1 + 0 + 0) / 3,
      recallAt3: (1 + 1 + 0) / 3,
      mrrAt1: (1 + 0 + 0) / 3,
      mrrAt3: (1 + 1 / 3 + 0) / 3,
      ndcgAt1: (1 + 0 + 0) / 3,
      ndcgAt3: (1 + 1 / Math.log2(4) + 0) / 3,
    });
  });
});
