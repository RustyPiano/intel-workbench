# Intel Workbench 归档说明

本项目已归档。课程材料见 [docs/delivery/](docs/delivery/README.md)，启动方法见 [README.md](README.md)，技术资料见 [docs/README.md](docs/README.md)。

## 目录

- `packages/core/`：模型调用、工具、会话、运行记录和命令行。
- `packages/server/`：素材加工、专题、问答、矛盾检测、结论复核、报告和审计。
- `packages/web/`：React 工作台。
- `docs/delivery/`：课程使用手册、技术方案、演示脚本和配图。
- `docs/reference/`：接口、配置和存储格式。
- `packages/server/eval/`、`packages/server/e2e/`：评估程序和结果。

## 数据与配置

- 业务数据位于 `.workbench-data/`；保留现有数据、配置和模型评估记录。
- 存储格式为 `schema_version=2`；程序拒绝读取未标记的非空目录和旧格式数据。
- 用户登录、专题分配、密级、引用验证、报告复核和审计检查由服务端执行。
- 同一份报告的作者、提交者与复核者分离；管理员对 Finding 的例外复核需要理由和审计记录。
- 密钥和真实服务配置保留在本地配置中。
- 归档包含未提交修改和关联 Git 工作目录，恢复开发时从各目录的现有状态继续。

## 恢复开发

使用根目录 `.nvmrc` 和 `package.json` 指定的 Node.js、pnpm 版本，执行：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

功能与验证记录见 [docs/claims-and-limitations.md](docs/claims-and-limitations.md)。课程文档、实验结果和原始数据分别保留在原目录。
