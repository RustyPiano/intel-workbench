import { describe, expect, it } from "vitest";

import { JobRegistry, type JobContext } from "../src/jobs/job-registry.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
}

describe("JobRegistry", () => {
  it("tracks a running job and marks it done with its result", async () => {
    const registry = new JobRegistry();
    const run = deferred<{ ok: true }>();

    const job = registry.start("case-1", "ingest", (ctx) => {
      ctx.setProgress({ phase: "reading", done: 1, total: 3 });
      return run.promise;
    });

    expect(job.state).toBe("running");
    expect(job.progress).toEqual({ phase: "reading", done: 1, total: 3 });
    expect(registry.status("case-1", "ingest")).toBe(job);

    run.resolve({ ok: true });
    await flushMicrotasks();

    expect(registry.status("case-1", "ingest")).toMatchObject({
      state: "done",
      result: { ok: true },
    });
  });

  it("dedupes running jobs for the same case and kind", () => {
    const registry = new JobRegistry();
    const run = deferred<string>();
    let calls = 0;

    const first = registry.start("case-1", "extract", () => {
      calls += 1;
      return run.promise;
    });
    const second = registry.start("case-1", "extract", () => {
      calls += 1;
      return Promise.resolve("second");
    });

    expect(second.id).toBe(first.id);
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  it("aborts a running job and marks it cancelled after settlement", async () => {
    const registry = new JobRegistry();
    const run = deferred<string>();
    let context: JobContext | undefined;

    const job = registry.start("case-1", "summarize", (ctx) => {
      context = ctx;
      return run.promise;
    });

    expect(registry.cancel("case-1", "summarize")).toBe(true);
    expect(context?.signal.aborted).toBe(true);
    expect(job.state).toBe("running");

    run.reject(new Error("stopped"));
    await flushMicrotasks();

    expect(job.state).toBe("cancelled");
    expect(registry.cancel("case-1", "summarize")).toBe(false);
  });

  it("marks non-abort runner failures as errors with the message", async () => {
    const registry = new JobRegistry();

    const job = registry.start("case-1", "classify", async () => {
      throw new Error("model unavailable");
    });
    await flushMicrotasks();

    expect(job.state).toBe("error");
    expect(job.error).toBe("model unavailable");
  });

  it("gets jobs by id and keeps different kinds independent for a case", () => {
    const registry = new JobRegistry();

    const ingest = registry.start("case-1", "ingest", () => new Promise(() => undefined));
    const review = registry.start("case-1", "review", () => new Promise(() => undefined));

    expect(ingest.id).not.toBe(review.id);
    expect(registry.get(ingest.id)).toBe(ingest);
    expect(registry.get(review.id)).toBe(review);
    expect(registry.status("case-1", "ingest")).toBe(ingest);
    expect(registry.status("case-1", "review")).toBe(review);
  });
});
