export function splitIntoBatches<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error("batch size must be at least 1");
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Runs workers with bounded concurrency and returns results aligned to input order.
 * Contract:
 * - The first worker rejection stops launching new work, lets in-flight workers
 *   settle, then rejects with that error.
 * - If `signal` aborts, no new workers are launched; in-flight workers settle;
 *   then the promise rejects with `signal.reason` (or an AbortError). An aborted
 *   run NEVER resolves — even if every launched worker happened to finish.
 * - `onSettled` is best-effort: a throw from it can neither stall the run nor
 *   surface as an unhandled rejection.
 */
export function mapWithConcurrency<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  opts: { concurrency: number; signal?: AbortSignal; onSettled?: (completed: number, total: number) => void },
): Promise<R[]> {
  if (opts.concurrency < 1) throw new Error("concurrency must be at least 1");
  if (items.length === 0) return Promise.resolve([]);

  return new Promise<R[]>((resolve, reject) => {
    const results = new Array<R>(items.length);
    let next = 0;
    let inFlight = 0;
    let completed = 0;
    let stopped = false;
    let settled = false;
    let firstError: unknown;

    const abortError = (): unknown => opts.signal?.reason ?? new DOMException("Aborted", "AbortError");

    const settle = (): void => {
      if (settled || inFlight > 0) return;
      if (firstError) {
        settled = true;
        reject(firstError);
      } else if (opts.signal?.aborted) {
        // 中止优先于"恰好全部完成"：被取消的运行一律拒绝，绝不当作成功返回。
        settled = true;
        reject(abortError());
      } else if (stopped && completed < items.length) {
        settled = true;
        reject(abortError());
      } else if (completed === items.length) {
        settled = true;
        resolve(results);
      }
    };

    const launchMore = (): void => {
      while (!stopped && !firstError && inFlight < opts.concurrency && next < items.length) {
        const index = next;
        next += 1;
        inFlight += 1;
        Promise.resolve()
          .then(() => worker(items[index]!, index))
          .then((result) => {
            results[index] = result;
          }, (error: unknown) => {
            firstError ??= error;
            stopped = true;
          })
          .finally(() => {
            inFlight -= 1;
            completed += 1;
            // 进度回调 best-effort：抛错不得打断调度或制造未处理拒绝。
            try {
              opts.onSettled?.(completed, items.length);
            } catch {
              /* ignore progress-callback errors */
            }
            if (opts.signal?.aborted) stopped = true;
            launchMore();
          });
      }
      settle();
    };

    if (opts.signal?.aborted) {
      reject(abortError());
      return;
    }

    opts.signal?.addEventListener("abort", () => {
      stopped = true;
      settle();
    }, { once: true });

    launchMore();
  });
}
