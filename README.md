# Intel Workbench

多源线索核验课程项目，已归档。程序按专题组织文档、音视频和图像，提供素材加工、检索、矛盾检测、结论复核及报告导出。

## 文档

- [课程材料](docs/delivery/README.md)：使用手册、技术方案、演示脚本和配图。
- [文档索引](docs/README.md)：运行、接口、存储与实验资料。
- [功能与验证记录](docs/claims-and-limitations.md)：已实现功能、历史评估和未完成事项。
- [运行时说明](packages/core/README.md)：通用模型调用、工具和命令行。

## 本地运行

Node.js 版本见 `.nvmrc`，pnpm 版本见根目录 `package.json` 的 `packageManager`。

```bash
nvm use
corepack enable
pnpm install --frozen-lockfile
pnpm dev:server
pnpm dev:web
```

普通模式的数据保存在 `.workbench-data/local`。首次创建管理员时，初始口令写入数据目录的 `config/initial-admin-password.json`，首次登录后修改口令。

演示模式：

```bash
MINI_AGENT_DEMO=1 pnpm dev:server
```

演示数据保存在 `.workbench-data/demo`。演示账号及配置见[运行手册](docs/how-to/run-the-workbench.md)。

## 检查

```bash
pnpm check
pnpm build
```

模型评估入口及结果在 `packages/server/eval/`，端到端验证资料在 `packages/server/e2e/`。历史评估的日期、模型、数据集和运行版本随结果保存。

## 数据与服务

文本模型使用 OpenAI-compatible 接口，音频、图像、向量检索等能力由本地配置指定。配置说明见[模型连接](docs/how-to/connect-openai-compatible-models.md)。

业务数据、上传素材、评估结果和课程成品保留在归档目录。恢复运行时使用原有配置和数据；备份方法见[备份与恢复](docs/operations/backup-restore.md)。
