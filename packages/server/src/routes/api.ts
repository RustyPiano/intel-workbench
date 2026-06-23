import { Router } from "express";

import type { AdminService } from "../admin/admin-service.js";
import type { AuditService } from "../audit/audit-service.js";
import type { AuthService } from "../auth/auth-service.js";
import type { ContradictionService } from "../analysis/contradiction-service.js";
import type { ElementGraphService } from "../analysis/element-graph-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { ElementService } from "../elements/element-service.js";
import type { FindingService } from "../finding/finding-service.js";
import type { InquiryService } from "../inquiry/inquiry-service.js";
import type { JobRegistry } from "../jobs/job-registry.js";
import type { MaterialService } from "../materials/material-service.js";
import type { OverviewService } from "../overview/overview-service.js";
import type { ReportService } from "../report/report-service.js";
import type { ReviewService } from "../review/review-service.js";
import type { TaskService } from "../task/task-service.js";
import { createAdminRouter } from "./admin.js";
import { createAuditRouter } from "./audit.js";
import { createAuthRouter } from "./auth.js";
import { createCasesRouter } from "./cases.js";
import { createContradictionsRouter } from "./contradictions.js";
import { createElementGraphRouter } from "./element-graph.js";
import { createElementsRouter } from "./elements.js";
import { createFindingsRouter } from "./findings.js";
import { createInquiriesRouter } from "./inquiries.js";
import { createJobsRouter } from "./jobs.js";
import { createMaterialsRouter } from "./materials.js";
import { createOverviewRouter } from "./overview.js";
import { createReviewRouter } from "./review.js";
import { createReportsRouter } from "./reports.js";
import { createTaskRouter } from "./tasks.js";

/**
 * API 装配（工程方案 §5）。M1–M5 + 鉴权全部接通：登录/会话、专题 CRUD、
 * 素材汇入/内容、问答带溯源、要素抽取、报告复核闸门、管理后台、审计 verify/导出。
 * 已无 HTTP 501 占位路由。
 */

export interface ApiServices {
  auth: AuthService;
  cases: CaseService;
  audit: AuditService;
  materials: MaterialService;
  overview: OverviewService;
  inquiries: InquiryService;
  jobRegistry: JobRegistry;
  elements: ElementService;
  findings: FindingService;
  elementGraph: ElementGraphService;
  contradictions: ContradictionService;
  reports: ReportService;
  review: ReviewService;
  tasks: TaskService;
  admin: AdminService;
}

export function createApiRouter(services: ApiServices): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // 自描述路由索引：M1–M5 + 鉴权全部做实，已无占位。
  router.get("/_routes", (_req, res) => {
    res.json({
      ok: true,
      note: "鉴权 + M1–M5 全部做实：登录/会话、专题 CRUD、素材汇入/内容、问答带溯源、要素抽取、报告复核闸门、管理后台、审计 verify/导出。",
      implemented: [
        "POST /api/auth/login",
        "POST /api/auth/change-password",
        "POST /api/auth/logout",
        "GET /api/auth/me",
        "GET/POST /api/cases",
        "GET/PATCH /api/cases/:id",
        "GET /api/overview",
        "GET/POST /api/cases/:id/materials",
        "POST /api/cases/:id/task-runs",
        "GET /api/cases/:id/task-runs/current",
        "GET /api/cases/:id/task-runs/:runId",
        "POST /api/cases/:id/task-runs/:runId/stages/:stageKey/{advance,confirm}",
        "POST /api/cases/:id/materials/:mid/{process,reindex}",
        "DELETE /api/cases/:id/materials/:mid",
        "GET /api/cases/:id/audit",
        "GET /api/materials/:mid",
        "GET/POST /api/cases/:id/inquiries",
        "GET/POST /api/cases/:id/elements",
        "GET/POST /api/cases/:id/findings",
        "POST /api/cases/:id/findings/:findingId/review",
        "PATCH /api/cases/:id/contradictions/:contradictionId/acknowledge",
        "POST /api/cases/:id/jobs/:kind/start",
        "GET /api/cases/:id/jobs/:kind/status",
        "POST /api/cases/:id/jobs/:kind/cancel",
        "GET /api/cases/:id/element-graph",
        "POST /api/cases/:id/review",
        "GET /api/cases/:id/report",
        "POST /api/cases/:id/report/{draft,submit,approve,export}",
        "GET /api/admin/{skills,models,users,prompts}",
        "POST /api/admin/skills/:name",
        "GET /api/audit",
        "GET /api/audit/verify",
        "POST /api/audit/export",
      ],
      stubs: [],
    });
  });

  router.use("/auth", createAuthRouter(services.auth));
  router.use("/overview", createOverviewRouter(services.overview));
  router.use("/cases", createCasesRouter(services.cases, services.materials, services.audit));
  router.use("/cases", createTaskRouter(services.tasks));
  router.use("/cases", createInquiriesRouter(services.inquiries));
  router.use("/cases", createJobsRouter({ registry: services.jobRegistry, elements: services.elements, contradictions: services.contradictions, cases: services.cases, audit: services.audit }));
  router.use("/cases", createElementsRouter(services.elements));
  router.use("/cases", createFindingsRouter(services.findings));
  router.use("/cases", createElementGraphRouter(services.elementGraph));
  router.use("/cases", createContradictionsRouter(services.contradictions));
  router.use("/cases", createReportsRouter(services.reports));
  router.use("/cases", createReviewRouter(services.review));
  router.use("/materials", createMaterialsRouter(services.materials));
  router.use("/admin", createAdminRouter(services.admin));
  router.use("/audit", createAuditRouter(services.audit));

  return router;
}
