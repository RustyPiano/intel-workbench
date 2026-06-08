import { Router, type Request, type Response } from "express";

import type { AdminService } from "../admin/admin-service.js";
import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { ElementService } from "../elements/element-service.js";
import type { InquiryService } from "../inquiry/inquiry-service.js";
import type { MaterialService } from "../materials/material-service.js";
import type { ReportService } from "../report/report-service.js";
import { createAdminRouter } from "./admin.js";
import { createAuditRouter } from "./audit.js";
import { createCasesRouter } from "./cases.js";
import { createElementsRouter } from "./elements.js";
import { createInquiriesRouter } from "./inquiries.js";
import { createMaterialsRouter } from "./materials.js";
import { createReportsRouter } from "./reports.js";

/**
 * API 装配（工程方案 §5）。
 *
 * 已做实（M1，数据底座）：专题 CRUD（`/cases`、`/cases/:id`）、审计列表与
 * 哈希链校验（`/audit`、`/audit/verify`）。其余路由仍按 §5 草案以 HTTP 501
 * 占位，不返回假数据——汇入/加工（M2）、问答溯源（M3）、报告（M4）、管理后台
 * （M5）逐里程碑接通。
 */

interface StubRoute {
  readonly method: "get" | "post" | "patch";
  readonly path: string;
  readonly summary: string;
  readonly disposition: "实" | "占" | "实/占";
}

/** 仍未接通的 §5 路由（已做实的专题/素材/审计路由不在此列）。 */
const STUB_ROUTES: readonly StubRoute[] = [
  { method: "post", path: "/auth/login", summary: "登录，返回会话与角色/密级", disposition: "实" },
] as const;

function notImplemented(route: StubRoute) {
  return (_req: Request, res: Response): void => {
    res.status(501).json({
      ok: false,
      error: "not_implemented",
      message: `该能力暂不可用（占位）：${route.summary}`,
      route: { method: route.method.toUpperCase(), path: `/api${route.path}`, disposition: route.disposition },
    });
  };
}

export interface ApiServices {
  cases: CaseService;
  audit: AuditService;
  materials: MaterialService;
  inquiries: InquiryService;
  elements: ElementService;
  reports: ReportService;
  admin: AdminService;
}

export function createApiRouter(services: ApiServices): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // 自描述路由索引：实 = 已接通，占 = HTTP 501 占位。
  router.get("/_routes", (_req, res) => {
    res.json({
      ok: true,
      note: "M1–M5：专题 CRUD、素材汇入/内容、问答带溯源、报告复核闸门、管理后台、审计 verify/导出 已做实；其余按 §5 占位（HTTP 501）。",
      implemented: [
        "GET/POST /api/cases",
        "GET/PATCH /api/cases/:id",
        "GET/POST /api/cases/:id/materials",
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
      stubs: STUB_ROUTES.map((r) => ({
        method: r.method.toUpperCase(),
        path: `/api${r.path}`,
        summary: r.summary,
        disposition: r.disposition,
      })),
    });
  });

  // 做实路由（挂在 stub 之前，未匹配的子路径回落到 stub）。
  router.use("/cases", createCasesRouter(services.cases, services.materials));
  router.use("/cases", createInquiriesRouter(services.inquiries));
  router.use("/cases", createElementsRouter(services.elements));
  router.use("/cases", createReportsRouter(services.reports));
  router.use("/materials", createMaterialsRouter(services.materials));
  router.use("/admin", createAdminRouter(services.admin));
  router.use("/audit", createAuditRouter(services.audit));

  for (const route of STUB_ROUTES) {
    router[route.method](route.path, notImplemented(route));
  }

  return router;
}
