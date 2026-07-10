import { Router } from "express";

import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import { AppError } from "../domain/identity.js";
import type { Job, JobRegistry } from "../jobs/job-registry.js";
import type { WorkflowService } from "../workflow/workflow-service.js";

type JobKind = "elements" | "contradictions" | "auto-inquiry";

export interface JobsRouterDeps {
  registry: JobRegistry;
  workflow: WorkflowService;
  cases: CaseService;
  audit: AuditService;
}

export function createJobsRouter(deps: JobsRouterDeps): Router {
  const router = Router();

  router.post("/:id/jobs/:kind/start", async (req, res) => {
    await deps.cases.get(req.identity, req.params.id);
    const kind = parseKind(req.params.kind);
    // 经 WorkflowService 启动：标记对应步骤 running 并在结束时回写终态（手动 job 同样回写）。
    const job = await deps.workflow.startJob(req.identity, req.params.id, kind);
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
  if (kind === "elements" || kind === "contradictions" || kind === "auto-inquiry") return kind;
  throw new AppError(400, "未知任务类型");
}

function serializeJob(job: Job) {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    progress: job.progress,
    error: job.error,
    // 矛盾检测结果随 job 回传供面板直用；自动研判进度以 workflow.json 的 inquiries items 为准，此处也附终态便于轮询。
    ...((job.kind === "contradictions" || job.kind === "auto-inquiry") && job.result !== undefined ? { result: job.result } : {}),
    startedAt: job.startedAt,
  };
}
