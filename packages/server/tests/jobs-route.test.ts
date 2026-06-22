import { describe, expect, it } from "vitest";

import type { Element } from "../src/domain/types.js";
import { JobRegistry, type JobContext } from "../src/jobs/job-registry.js";

async function flushMicrotasks() {
  await Promise.resolve();
}

describe("jobs route runner wiring", () => {
  it("records progress from an element extraction runner and finishes done", async () => {
    const registry = new JobRegistry();
    const sentinel: Element[] = [];
    const actor = { id: "op", name: "op", role: "operator" as const, clearance: "internal" as const };
    const elements = {
      async extract(
        seenActor: typeof actor,
        caseId: string,
        opts: { signal?: AbortSignal; onProgress?: (p: { done: number; total: number }) => void },
      ): Promise<Element[]> {
        expect(seenActor).toBe(actor);
        expect(caseId).toBe("case-1");
        expect(opts.signal?.aborted).toBe(false);
        opts.onProgress?.({ done: 1, total: 2 });
        return sentinel;
      },
    };

    const runner = (ctx: JobContext) => {
      const onProgress = (p: { done: number; total: number }) => ctx.setProgress({ phase: "elements", done: p.done, total: p.total });
      return elements.extract(actor, "case-1", { signal: ctx.signal, onProgress });
    };

    const job = registry.start("case-1", "elements", runner);

    expect(job.state).toBe("running");
    expect(registry.status("case-1", "elements")).toMatchObject({
      state: "running",
      progress: { phase: "elements", done: 1, total: 2 },
    });

    await flushMicrotasks();

    expect(registry.status("case-1", "elements")).toMatchObject({
      state: "done",
      progress: { phase: "elements", done: 1, total: 2 },
      result: sentinel,
    });
  });

  it("passes the abort signal through the runner used for cancellation", async () => {
    const registry = new JobRegistry();
    let observedSignal: AbortSignal | undefined;

    const job = registry.start("case-1", "elements", (ctx) => {
      observedSignal = ctx.signal;
      return new Promise<Element[]>((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve([]), { once: true });
      });
    });

    expect(registry.cancel("case-1", "elements")).toBe(true);
    expect(observedSignal?.aborted).toBe(true);

    await flushMicrotasks();

    expect(job.state).toBe("cancelled");
  });
});
