import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // 让工作区包 `mini-agent`（被 packages/server 运行时引用）在测试中稳定解析到
  // 其 TS 源，避免依赖 dist 构建顺序与 vite 入口解析竞态。
  resolve: {
    alias: {
      "mini-agent": path.resolve(root, "packages/core/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
});
