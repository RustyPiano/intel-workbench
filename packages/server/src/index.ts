/**
 * 情报分析工作台 — 本地 HTTP 服务入口（M1）。
 *
 * 红线：本服务**只绑定 127.0.0.1**，绝不监听 0.0.0.0 或外部网卡；
 * 本进程不发起任何对外网络调用（暂不接任何模型/云端能力）。
 */

import { RuntimeAgent, RUNTIME_VERSION } from "mini-agent";

import type { AppServices } from "./app.js";
import { createApp } from "./app.js";

// Loopback only — never 0.0.0.0. (零外发红线，§7.1)
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 4319);

/**
 * Smoke check that the workspace wiring resolves `mini-agent` (core).
 * We only assert the symbol is importable — M0 does not drive the agent.
 */
function assertCoreWiring(): void {
  if (typeof RuntimeAgent?.create !== "function") {
    throw new Error("workspace 接线失败：未能从 'mini-agent' 解析到 RuntimeAgent.create");
  }
}

/** 启动对账：列出有产物却缺审计的孤儿专题（§5.4），仅记日志、不阻塞启动。 */
async function reconcileAtStartup(services: AppServices): Promise<string> {
  const { ok, orphanCases } = await services.audit.reconcile(await services.cases.listIds());
  return ok
    ? `  对账:         无孤儿专题`
    : `  对账:         ⚠ ${orphanCases.length} 个专题缺审计：${orphanCases.join(", ")}`;
}

function main(): void {
  assertCoreWiring();

  const app = createApp();
  const services = app.locals.services as AppServices;
  const server = app.listen(PORT, HOST, () => {
    void reconcileAtStartup(services).then((reconcileLine) => {
      // eslint-disable-next-line no-console
      console.log(
        [
          `情报分析工作台 server (M3) 已启动`,
          `  runtime core: mini-agent v${RUNTIME_VERSION}（RuntimeAgent 接线 OK）`,
          `  health:       http://${HOST}:${PORT}/api/health`,
          `  routes index: http://${HOST}:${PORT}/api/_routes`,
          `  数据根:       ${services.paths.root}`,
          `  文本模型:     ${services.modelConfigured ? "已配置" : "未配置（问答降级）"}`,
          `  外发白名单:   ${services.egressAllowlist.length ? services.egressAllowlist.join(", ") : "（空，全断）"}`,
          reconcileLine,
          `  绑定:         ${HOST}（仅 loopback，无对外监听）`,
        ].join("\n"),
      );
    });
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
