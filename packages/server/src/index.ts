/**
 * 情报分析工作台 — 本地 HTTP 服务入口（M1）。
 *
 * HTTP listener is loopback-bound; model egress is OfflineGuard-authorized to allowlisted local endpoints.
 */

import { RuntimeAgent, RUNTIME_VERSION } from "mini-agent";

import type { AppServices } from "./app.js";
import { createApp } from "./app.js";
import { acquireDataRootLock } from "./data/data-root-lock.js";
import { dataRootIsEmpty, demoDataRoot, findLegacyArtifacts, seedDemoWorkspace } from "./demo/seed.js";

// Loopback only — never 0.0.0.0. (零外发红线，§7.1)
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 4319);

/**
 * Smoke check that the workspace wiring resolves `mini-agent` (core).
 * We only assert the symbol is importable — this smoke check does not drive the agent.
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

async function main(): Promise<void> {
  assertCoreWiring();

  // 演示模式（MINI_AGENT_DEMO=1）数据根固定为 <仓库根>/.workbench-data/demo；
  // 显式设置 WORKBENCH_DATA_DIR 时以显式值优先并提示。
  const demoMode = process.env.MINI_AGENT_DEMO === "1";
  let dataDir: string | undefined;
  if (demoMode) {
    if (process.env.WORKBENCH_DATA_DIR) {
      // eslint-disable-next-line no-console
      console.log(`MINI_AGENT_DEMO=1：检测到显式 WORKBENCH_DATA_DIR，数据根以显式值优先（${process.env.WORKBENCH_DATA_DIR}），不使用固定演示数据根。`);
    } else {
      dataDir = demoDataRoot();
    }
  }

  const app = createApp(dataDir ? { dataDir } : {});
  const services = app.locals.services as AppServices;

  // 数据根独占锁：同一数据根不得两进程并发写，否则审计哈希链会分叉（§4.1）。
  const lock = await acquireDataRootLock(services.paths.root);

  // 启动前完整校验审计哈希链：断链即拒绝启动（§7.2），避免在断链上继续追加。
  try {
    await services.audit.initialize();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    await lock.release();
    process.exit(1);
  }

  // 旧格式零兼容：cases/*/ 下命中 R1/R2 前的状态文件即拒绝启动（不迁移、不降级）。
  const legacy = await findLegacyArtifacts(services.paths.casesDir);
  if (legacy.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      [
        "数据根包含旧格式痕迹文件，拒绝启动：",
        ...legacy.map((file) => `  - ${file}`),
        "请执行 pnpm demo:reset 重建演示数据根；若为自定数据根，请先迁走旧数据再重启。",
      ].join("\n"),
    );
    await lock.release();
    process.exit(1);
  }

  // 演示播种只写空数据根：非空（已播种或已有数据）直接沿用现有数据。
  if (demoMode && (await dataRootIsEmpty(services.paths.root))) {
    const seeded = await seedDemoWorkspace(services.paths, services.audit);
    // eslint-disable-next-line no-console
    console.log(`演示专题已初始化: ${seeded.caseId}`);
  }

  // 崩溃清扫先于服务（§4.1）：把上次中断遗留的 `processing` 素材翻 `failed` 可重试。
  const swept = await services.cases.sweepInterrupted();
  const sweptLine = swept.length
    ? `  崩溃清扫:     ⚠ ${swept.length} 件中断素材已转 failed（可重试）`
    : `  崩溃清扫:     无中断素材`;

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
          sweptLine,
          reconcileLine,
          `  绑定:         ${HOST}（仅 loopback，无对外监听）`,
        ].join("\n"),
      );
    });
  });

  const shutdown = (): void => {
    server.close(() => {
      void lock.release().finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  // 启动期致命错误（如数据根被占用）：打印清晰信息并非零退出，不抛裸栈。
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
