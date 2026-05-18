import { describe, expect, test } from "vitest";

import { FileMutationQueue } from "../../src/tools/file-mutation-queue.js";

describe("FileMutationQueue", () => {
  test("serializes concurrent operations on the same path", async () => {
    const queue = new FileMutationQueue();
    const filePath = "/tmp/file-mutation-queue/serial.txt";

    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];

    const tasks = Array.from({ length: 100 }, (_, index) =>
      queue.runExclusive(filePath, async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Give the event loop a chance to interleave; with the queue this
        // window must never let another operation in.
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push(index);
        inFlight -= 1;
        return index;
      }),
    );

    const results = await Promise.all(tasks);

    expect(maxInFlight).toBe(1);
    expect(results).toEqual(order);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("does not leak entries in the inFlight map after completion", async () => {
    const queue = new FileMutationQueue();
    const inFlight = (queue as unknown as { inFlight: Map<string, Promise<void>> }).inFlight;

    const operations = Array.from({ length: 500 }, (_, index) => {
      // Spread across multiple paths so we exercise both per-path serialization
      // and the cleanup logic for the final operation on each path.
      const filePath = `/tmp/file-mutation-queue/path-${index % 10}.txt`;
      return queue.runExclusive(filePath, async () => index);
    });

    await Promise.all(operations);

    expect(inFlight.size).toBe(0);
  });

  test("releases inFlight entries even when the operation rejects", async () => {
    const queue = new FileMutationQueue();
    const inFlight = (queue as unknown as { inFlight: Map<string, Promise<void>> }).inFlight;
    const filePath = "/tmp/file-mutation-queue/error.txt";

    await expect(
      queue.runExclusive(filePath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(inFlight.size).toBe(0);

    // Subsequent operations should still run after a failed one.
    const result = await queue.runExclusive(filePath, async () => "recovered");
    expect(result).toBe("recovered");
    expect(inFlight.size).toBe(0);
  });
});
