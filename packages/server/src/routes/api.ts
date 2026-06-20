import { Router } from "express";

import type { AdminService } from "../admin/admin-service.js";
import type { AuditService } from "../audit/audit-service.js";
import type { AuthService } from "../auth/auth-service.js";
import type { ContradictionService } from "../analysis/contradiction-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { ElementService } from "../elements/element-service.js";
import type { InquiryService } from "../inquiry/inquiry-service.js";
import type { MaterialService } from "../materials/material-service.js";
import type { ReportService } from "../report/report-service.js";
import { createAdminRouter } from "./admin.js";
import { createAuditRouter } from "./audit.js";
import { createAuthRouter } from "./auth.js";
import { createCasesRouter } from "./cases.js";
import { createContradictionsRouter } from "./contradictions.js";
import { createElementsRouter } from "./elements.js";
import { createInquiriesRouter } from "./inquiries.js";
import { createMaterialsRouter } from "./materials.js";
import { createReportsRouter } from "./reports.js";

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
  inquiries: InquiryService;
  elements: ElementService;
  contradictions: ContradictionService;
  reports: ReportService;
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
        "POST /api/auth/logout",
        "GET /api/auth/me",
        "GET/POST /api/cases",
        "GET/PATCH /api/cases/:id",
        "GET/POST /api/cases/:id/materials",
        "POST /api/cases/:id/materials/:mid/{process,reindex}",
        "DELETE /api/cases/:id/materials/:mid",
        "GET /api/cases/:id/audit",
        "GET /api/materials/:mid",
        "GET/POST /api/cases/:id/inquiries",
        "GET/POST /api/cases/:id/elements",
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
  router.use("/cases", createCasesRouter(services.cases, services.materials, services.audit));
  router.use("/cases", createInquiriesRouter(services.inquiries));
  router.use("/cases", createElementsRouter(services.elements));
  router.use("/cases", createContradictionsRouter(services.contradictions));
  router.use("/cases", createReportsRouter(services.reports));
  router.use("/materials", createMaterialsRouter(services.materials));
  router.use("/admin", createAdminRouter(services.admin));
  router.use("/audit", createAuditRouter(services.audit));

  return router;
}
