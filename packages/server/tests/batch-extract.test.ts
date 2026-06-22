import { describe, expect, it } from "vitest";

import { mapWithConcurrency, splitIntoBatches } from "../src/analysis/batch-extract.js";

function delay(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("splitIntoBatches", () => {
  it("splits with a remainder", () => {
    expect(splitIntoBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("handles size 1, size greater than length, and empty input", () => {
    expect(splitIntoBatches([1, 2], 1)).toEqual([[1], [2]]);
    expect(splitIntoBatches([1, 2], 5)).toEqual([[1, 2]]);
    expect(splitIntoBatches([], 3)).toEqual([]);
  });

  it("rejects non-positive batch sizes", () => {
    expect(() => splitIntoBatches([1], 0)).toThrow("batch size must be at least 1");
  });
});

describe("mapWithConcurrency", () => {
  it("caps in-flight workers at the configured concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    await mapWithConcurrency([1, 2, 3, 4, 5, 6], async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5);
      inFlight -= 1;
      return item;
    }, { concurrency: 2 });

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("preserves input order even when workers settle out of order", async () => {
    const result = await mapWithConcurrency([30, 10, 20], async (ms, index) => {
      await delay(ms);
      return index;
    }, { concurrency: 3 });

    expect(result).toEqual([0, 1, 2]);
  });

  it("reports settled counts after each worker settles", async () => {
    const counts: Array<[number, number]> = [];

    await mapWithConcurrency(["a", "b", "c"], async (item) => item.toUpperCase(), {
      concurrency: 2,
      onSettled: (completed, total) => counts.push([completed, total]),
    });

    expect(counts).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it("rejects worker failures after in-flight work settles and stops launching new work", async () => {
    const launched: number[] = [];
    const settled: number[] = [];

    await expect(mapWithConcurrency([1, 2, 3, 4], async (item) => {
      launched.push(item);
      await delay(5);
      settled.push(item);
      if (item === 1) throw new Error("boom");
      return item;
    }, { concurrency: 2 })).rejects.toThrow("boom");

    expect(launched).toEqual([1, 2]);
    expect(settled).toEqual([1, 2]);
  });

  it("aborts by stopping new launches, letting in-flight workers settle, then rejecting", async () => {
    const controller = new AbortController();
    const launched: number[] = [];
    const settled: number[] = [];

    await expect(mapWithConcurrency([1, 2, 3, 4], async (item) => {
      launched.push(item);
      if (item === 1) controller.abort(new Error("stop"));
      await delay(5);
      settled.push(item);
      return item;
    }, { concurrency: 2, signal: controller.signal })).rejects.toThrow("stop");

    expect(launched).toEqual([1, 2]);
    expect(settled).toEqual([1, 2]);
  });

  it("survives a throwing onSettled callback without hanging or rejecting", async () => {
    const result = await mapWithConcurrency([1, 2, 3], async (item) => item * 2, {
      concurrency: 2,
      onSettled: () => {
        throw new Error("progress boom");
      },
    });

    expect(result).toEqual([2, 4, 6]);
  });
});
