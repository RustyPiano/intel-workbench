import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createModelAdapter, RUNTIME_VERSION, type ModelAdapter } from "mini-agent";
import express, { type ErrorRequestHandler, type Express } from "express";

import { AdminService } from "./admin/admin-service.js";
import { AuditService } from "./audit/audit-service.js";
import { AuthService } from "./auth/auth-service.js";
import { UserStore } from "./auth/user-store.js";
import { CaseService } from "./cases/case-service.js";
import { defaultDataDir, resolveDataPaths, type DataPaths } from "./data/paths.js";
import { AppError, authMiddleware } from "./domain/identity.js";
import { ElementService } from "./elements/element-service.js";
import { InquiryService } from "./inquiry/inquiry-service.js";
import { MaterialService } from "./materials/material-service.js";
import { buildSlots } from "./model/mock-slots.js";
import { readSlotConfigs, slotAllowlistHosts, useMockMedia } from "./model/slot-config.js";
import type { ModelSlots } from "./model/slots.js";
import type { LlmDeps } from "./model/structured.js";
import { readModelConfig } from "./model/model-config.js";
import { ReportService } from "./report/report-service.js";
import { OfflineGuard } from "./security/offline-guard.js";
import { createApiRouter } from "./routes/api.js";

export interface CreateAppOptions {
  /**
   * Absolute path to the built web app (`packages/web/dist`). When present and
   * the directory exists, the server serves it as static files with SPA
   * fallback. In dev this is omitted — the web app is served by Vite and the
   * server only exposes the API (Vite proxies `/api` here).
   */
  webDistDir?: string;
  /** 数据根目录（落盘）。默认 `WORKBENCH_DATA_DIR` 或进程工作目录。 */
  dataDir?: string;
  /** 开发模式（§7.5）。默认开启，置 `WORKBENCH_DEV_MODE=false` 关闭。 */
  devMode?: boolean;
}

/** 暴露给入口的服务集合（启动时对账用），挂在 `app.locals.services`。 */
export interface AppServices {
  paths: DataPaths;
  audit: AuditService;
  cases: CaseService;
  materials: MaterialService;
  inquiries: InquiryService;
  elements: ElementService;
  reports: ReportService;
  admin: AdminService;
  /** 模型槽适配器（二期 P2.2；mock-first，供媒体管线/稠密检索消费）。 */
  slots: ModelSlots;
  /** 文本 LLM 是否已配置（供启动日志/降级判断）。 */
  modelConfigured: boolean;
  /** OfflineGuard 当前白名单（启动日志展示）。 */
  egressAllowlist: string[];
}

/**
 * Resolve the default location of the web build relative to this file.
 * Works both for `tsx` (src/) and the compiled output (dist/).
 */
export function defaultWebDistDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // server/{src,dist}/ -> packages/web/dist
  return path.resolve(here, "..", "..", "web", "dist");
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();

  // Disable the framework banner header; nothing about this server should be
  // advertised externally (it only ever binds 127.0.0.1).
  app.disable("x-powered-by");

  // 素材以 base64 内联上传，放宽 JSON 体积上限（本地单机应用）。
  app.use(express.json({ limit: "25mb" }));

  // 数据底座与用例服务（M1–M2）。
  const paths = resolveDataPaths(options.dataDir ?? defaultDataDir());
  const devMode = options.devMode ?? process.env.WORKBENCH_DEV_MODE !== "false";
  const audit = new AuditService(paths);
  const users = new UserStore(paths);
  const auth = new AuthService(users, audit);
  const cases = new CaseService(paths, audit, devMode);

  // 文本 LLM + 零外发闸门（M3）。开发期白名单仅模型端点 host；未配置则白名单为空
  // → 任何出站皆被拒并落审计（生产置空即一键全断，§7.1）。
  const model = readModelConfig();
  const adapter: ModelAdapter | null = model.configured
    ? createModelAdapter({ provider: model.provider, model: model.model, baseURL: model.baseURL, apiKey: model.apiKey })
    : null;
  // 模型槽（Embedding/Reranker/ASR/VLM/OCR，二期 P2.2）：已配置槽 host 并入白名单
  // （真实接入 P2.6 时"插上即用"），适配器本期 mock-first（开关 MINI_AGENT_USE_MOCK_MEDIA）。
  const slotConfigs = readSlotConfigs();
  const guard = new OfflineGuard(
    [...(model.configured ? [model.host] : []), ...slotAllowlistHosts(slotConfigs)],
    audit,
  );
  const slots: ModelSlots = buildSlots(useMockMedia());
  // 素材服务依赖模型槽（媒体加工取 slots.asr，二期 P2.3a），故在槽构建之后装配。
  const materials = new MaterialService(paths, audit, cases, slots);
  const llm: LlmDeps = { adapter, guard, modelEndpoint: model.configured ? model.baseURL : "" };
  // 稠密检索依赖（二期 P2.4）：embed 槽 + 端点（real 出站前授权；mock 进程内为空）。
  const dense = { embed: slots.embed, embedEndpoint: slotConfigs.embed.configured ? slotConfigs.embed.baseURL : "" };
  // 重排依赖（二期 P2.5，可选门控）：rerank 槽 + 端点（real 出站前授权；mock 进程内为空）；缺省 null → 不重排。
  const rerank = { reranker: slots.rerank, rerankEndpoint: slotConfigs.rerank.configured ? slotConfigs.rerank.baseURL : "" };
  const inquiries = new InquiryService(paths, audit, cases, materials, llm, dense, rerank, {
    agentWorkspaceRoot: path.join(paths.root, ".agent-scratch"),
    runtimeVersion: RUNTIME_VERSION,
    modelName: model.model || "unconfigured",
    providerName: model.provider,
  });
  const elements = new ElementService(paths, audit, cases, materials, llm);
  const reports = new ReportService(paths, audit, cases);
  const admin = new AdminService(paths, audit, model, guard.allowlist, users);

  const services: AppServices = {
    paths,
    audit,
    cases,
    materials,
    inquiries,
    elements,
    reports,
    admin,
    slots,
    modelConfigured: model.configured,
    egressAllowlist: guard.allowlist,
  };
  app.locals.services = services;

  // API surface：会话鉴权（公开路由放行，其余须有效令牌）→ 路由。
  app.use("/api", authMiddleware(auth), createApiRouter({ auth, cases, audit, materials, inquiries, elements, reports, admin }));

  // Production static hosting of the web build. In dev this is skipped.
  const webDistDir = options.webDistDir ?? defaultWebDistDir();
  if (existsSync(webDistDir)) {
    app.use(express.static(webDistDir));
    // SPA fallback: any non-API GET serves index.html so react-router can route.
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(webDistDir, "index.html"));
    });
  }

  app.use(errorHandler);
  return app;
}

/** 统一错误出口：AppError 用其状态码，其余视作 500，均回 JSON。 */
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = err instanceof AppError ? err.status : 500;
  const message = err instanceof Error ? err.message : "服务器错误";
  res.status(status).json({
    ok: false,
    error: status === 500 ? "internal_error" : "request_error",
    message,
  });
};
