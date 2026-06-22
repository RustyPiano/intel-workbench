# Intel Workbench

离线多模态情报证据分析工作台。Intel Workbench 面向受控/离线环境中的案卷研判：素材进入本地工作区后，系统完成加工、检索、矛盾检测、报告复核与审计留痕，并把模型输出约束在可复核证据链内。

核心能力：

- 多模态素材加工：文档、音频、图像、视频进入同一专题，产出文本块、转写、OCR、帧级线索与加工状态。
- 证据级溯源：回答、矛盾线索、报告草稿绑定素材片段、定位信息与内容哈希，便于复核员回查。
- 矛盾与交叉验证：从已加工素材中抽取陈述，跨素材/素材内比对冲突，并展示覆盖范围与降级状态。
- 任务化研判：围绕专题组织素材、要素、问答、矛盾、报告与复核，不要求分析员直接操作底层 agent。
- 报告复核与审计：报告走草稿、提交、核准、导出状态；关键操作写入哈希链审计日志，可做完整性校验。

底层使用自研 Agent Runtime 作为基础设施；通用 runtime/CLI/工具开发文档见 [packages/core/README.md](packages/core/README.md)。

## Quick Start

安装依赖并运行检查：

```bash
npm install
npm run check
```

启动本地 API 与 Web：

```bash
npm run dev:server
npm run dev:web
```

首次启动会创建 `admin` 管理员，生成一次性随机口令：

- 服务端 stdout 会打印一次 `Intel Workbench initial admin password: ...`
- 同一口令也会写入受限文件 `config/initial-admin-password.json`
- 首次登录后必须改为长度至少 12 位的新口令

默认不创建演示账号。确需演示固定账号时，显式设置：

```bash
MINI_AGENT_DEMO=1 npm run dev:server
```

## Local Model Path

Intel Workbench 的主路径是本地/内网模型服务。文本模型按 OpenAI-compatible 接口配置：

```bash
export MINI_AGENT_PROVIDER=openai-compatible
export MINI_AGENT_MODEL=local-intel-llm
export MINI_AGENT_BASE_URL=http://127.0.0.1:8000/v1
export MINI_AGENT_API_KEY=local-dev-key
```

媒体槽位（ASR/OCR/VLM/Embedding/Rerank）也应优先指向本地或内网端点。未配置时，相关能力会降级或停用；应用层出站统一经过 OfflineGuard 白名单审计。

## Optional Dev Cloud Stand-Ins

开发期可以用云端兼容服务替代本地模型做联调，例如 DeepSeek/OpenAI-compatible 文本端点、`gpt-4.1`、DashScope 多模态、豆包 ASR，或火山 TOS 作为大文件临时 URL 通道。这些只是开发替身，不是离线部署主路径；生产/涉密环境应改回本地服务或部署在真正离线网络内。

## Repository Layout

- `packages/server`：Intel Workbench API、鉴权、专题、素材、矛盾检测、报告、审计。
- `packages/web`：React 工作台界面。
- `packages/core`：自研 Agent Runtime、CLI、工具、技能、会话与 trace 基础设施。
- `docs`：产品规格、工程计划、运行说明、评测与交接文档。

## Verification

```bash
npm run typecheck
npm run test:run
npm run check
```

Codex 沙箱可能因 TCP 权限导致 `packages/server/tests/api.test.ts` 出现 null port/EPERM 假阴性，`packages/core/tests/unit/bash.test.ts` 偶发波动；以本机完整 `npm run check` 为准。
