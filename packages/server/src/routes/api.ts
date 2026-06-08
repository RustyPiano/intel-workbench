import { Router, type Request, type Response } from "express";

import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import type { MaterialService } from "../materials/material-service.js";
import { createAuditRouter } from "./audit.js";
import { createCasesRouter } from "./cases.js";
import { createMaterialsRouter } from "./materials.js";

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
  { method: "post", path: "/cases/:id/inquiries", summary: "问答 → 检索+结构化生成+校验管线", disposition: "实" },
  { method: "get", path: "/cases/:id/inquiries", summary: "问答记录", disposition: "实" },
  { method: "get", path: "/cases/:id/elements", summary: "要素/关系/时间线", disposition: "占" },
  { method: "post", path: "/cases/:id/report/draft", summary: "生成报告草稿（调 intel-bulletin 渲染脚本）", disposition: "实" },
  { method: "post", path: "/cases/:id/report/submit", summary: "提交复核", disposition: "实" },
  { method: "post", path: "/cases/:id/report/approve", summary: "复核核准（保密员/管理员）", disposition: "实" },
  { method: "post", path: "/cases/:id/report/export", summary: "导出（未复核态拒绝）", disposition: "实" },
  { method: "get", path: "/admin/prompts", summary: "提示词模板（内置基线只读）", disposition: "占" },
  { method: "get", path: "/admin/skills", summary: "Skill 列表 + 启停 + 自检", disposition: "实" },
  { method: "get", path: "/admin/models", summary: "模型配置 + 自检（doctor）", disposition: "实" },
  { method: "get", path: "/admin/users", summary: "用户管理", disposition: "实" },
  { method: "post", path: "/audit/export", summary: "导出留存（导出本身入审计）", disposition: "实" },
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
      note: "M1–M2：专题 CRUD、素材汇入/列表/内容、审计 verify 已做实；其余按 §5 占位（HTTP 501），不返回假数据。",
      implemented: [
        "GET /api/cases",
        "POST /api/cases",
        "GET /api/cases/:id",
        "PATCH /api/cases/:id",
        "GET /api/cases/:id/materials",
        "POST /api/cases/:id/materials",
        "GET /api/materials/:mid",
        "GET /api/audit",
        "GET /api/audit/verify",
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
  router.use("/materials", createMaterialsRouter(services.materials));
  router.use("/audit", createAuditRouter(services.audit));

  for (const route of STUB_ROUTES) {
    router[route.method](route.path, notImplemented(route));
  }

  return router;
}
