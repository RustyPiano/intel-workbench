import { shortId } from "../util/hash.js";

export type JobState = "running" | "done" | "error" | "cancelled";

export interface JobProgress {
  phase: string;
  done: number;
  total: number;
  detail?: Record<string, unknown>;
}

export interface Job<R = unknown> {
  id: string;
  caseId: string;
  kind: string;
  state: JobState;
  progress: JobProgress;
  result?: R;
  error?: string;
  startedAt: string;
}

export interface JobContext {
  signal: AbortSignal;
  setProgress(patch: Partial<JobProgress>): void;
}

export class JobRegistry {
  private readonly jobsByPair = new Map<string, Job>();
  private readonly jobsById = new Map<string, Job>();
  private readonly controllersByPair = new Map<string, AbortController>();

  start<R>(caseId: string, kind: string, runner: (ctx: JobContext) => Promise<R>): Job<R> {
    const key = this.key(caseId, kind);
    const current = this.jobsByPair.get(key);
    if (current?.state === "running") return current as Job<R>;

    const controller = new AbortController();
    const job: Job<R> = {
      id: shortId("job-"),
      caseId,
      kind,
      state: "running",
      progress: { phase: "", done: 0, total: 0 },
      startedAt: new Date().toISOString(),
    };
    const ctx: JobContext = {
      signal: controller.signal,
      setProgress: (patch) => {
        job.progress = { ...job.progress, ...patch };
      },
    };

    this.jobsByPair.set(key, job);
    this.jobsById.set(job.id, job);
    this.controllersByPair.set(key, controller);

    try {
      runner(ctx)
        .then((result) => {
          if (controller.signal.aborted) {
            job.state = "cancelled";
          } else {
            job.result = result;
            job.state = "done";
          }
        })
        .catch((error: unknown) => {
          this.fail(job, controller, error);
        })
        .finally(() => {
          this.controllersByPair.delete(key);
        });
    } catch (error) {
      this.fail(job, controller, error);
      this.controllersByPair.delete(key);
    }

    return job;
  }

  status(caseId: string, kind: string): Job | undefined {
    return this.jobsByPair.get(this.key(caseId, kind));
  }

  cancel(caseId: string, kind: string): boolean {
    const key = this.key(caseId, kind);
    const job = this.jobsByPair.get(key);
    const controller = this.controllersByPair.get(key);
    if (job?.state !== "running" || !controller) return false;

    controller.abort();
    return true;
  }

  get(id: string): Job | undefined {
    return this.jobsById.get(id);
  }

  private fail(job: Job, controller: AbortController, error: unknown): void {
    if (controller.signal.aborted) {
      job.state = "cancelled";
      return;
    }

    job.state = "error";
    job.error = error instanceof Error ? error.message : String(error);
  }

  private key(caseId: string, kind: string): string {
    return `${caseId}\0${kind}`;
  }
}
