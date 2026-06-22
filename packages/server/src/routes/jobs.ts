import { Router } from "express";

import type { ContradictionService } from "../analysis/contradiction-service.js";
import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import { AppError } from "../domain/identity.js";
import type { ElementService } from "../elements/element-service.js";
import type { Job, JobProgress, JobRegistry } from "../jobs/job-registry.js";

type JobKind = "elements" | "contradictions";

export interface JobsRouterDeps {
  registry: JobRegistry;
  elements: ElementService;
  contradictions: ContradictionService;
  cases: CaseService;
  audit: AuditService;
}

export function createJobsRouter(deps: JobsRouterDeps): Router {
  const router = Router();

  router.post("/:id/jobs/:kind/start", async (req, res) => {
    await deps.cases.get(req.identity, req.params.id);
    const kind = parseKind(req.params.kind);
    const actor = req.identity;
    const caseId = req.params.id;
    const runner = (ctx: { signal: AbortSignal; setProgress(patch: Partial<JobProgress>): void }) => {
      const onProgress = (p: { done: number; total: number }) => ctx.setProgress({ phase: kind, done: p.done, total: p.total });
      return kind === "elements"
        ? deps.elements.extract(actor, caseId, { signal: ctx.signal, onProgress })
        : deps.contradictions.detect(actor, caseId, { signal: ctx.signal, onProgress });
    };
    const job = deps.registry.start<unknown>(req.params.id, kind, runner);
    res.status(202).json({ ok: true, job: serializeJob(job) });
  });

  router.get("/:id/jobs/:kind/status", async (req, res) => {
    await deps.cases.get(req.identity, req.params.id);
    const kind = parseKind(req.params.kind);
    const job = deps.registry.status(req.params.id, kind);
    res.json({ ok: true, job: job ? serializeJob(job) : null });
  });

  router.post("/:id/jobs/:kind/cancel", async (req, res) => {
    await deps.cases.get(req.identity, req.params.id);
    const kind = parseKind(req.params.kind);
    const cancelled = deps.registry.cancel(req.params.id, kind);
    if (cancelled) {
      try {
        await deps.audit.append({
          user: req.identity.id,
          action: "job.cancel",
          object: `case:${req.params.id}`,
          caseId: req.params.id,
          detail: { kind },
        });
      } catch {
        // Cancellation already happened; audit is best-effort for this endpoint.
      }
    }
    res.json({ ok: true, cancelled });
  });

  return router;
}

function parseKind(kind: string): JobKind {
  if (kind === "elements" || kind === "contradictions") return kind;
  throw new AppError(400, "未知任务类型");
}

function serializeJob(job: Job) {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    progress: job.progress,
    error: job.error,
    ...(job.kind === "contradictions" && job.result !== undefined ? { result: job.result } : {}),
    startedAt: job.startedAt,
  };
}
