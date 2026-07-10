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
pnpm install
pnpm check
```

启动本地 API 与 Web：

```bash
pnpm dev:server
pnpm dev:web
```

首次启动会创建 `admin` 管理员，生成一次性随机口令：

- 服务端 stdout 会打印一次 `Intel Workbench initial admin password: ...`
- 同一口令也会写入受限文件 `config/initial-admin-password.json`
- 首次登录后必须改为长度至少 12 位的新口令

默认不创建演示账号。确需演示固定账号时，显式设置：

```bash
MINI_AGENT_DEMO=1 pnpm dev:server
```

该模式会初始化课程演示数据：`港口异常活动线索核验（模拟数据）`、一条绝密留存样例，预置素材/要素/矛盾（7 条，6 条已处置、留 1 条供现场演示处置）/自动研判批次/问答/Finding/报告草稿，报告覆盖率开箱即 4/5，外加一条越权拒绝审计。演示账号：

| 账号 | 口令 | 角色 / 密级 |
| --- | --- | --- |
| `operator` | `operator123456` | 作业员 / 机密 |
| `security` | `security123456` | 保密员 / 绝密 |
| `admin` | `admin12345678` | 管理员 / 绝密 |

## 研判简报与自动流水线

素材上传加工完成后，系统会自动推进核验流水线（要素抽取 → 矛盾检测 → 自动研判批量问答），无需逐项点击；进入专题默认首屏即"研判简报"——案情概览、时间线、矛盾、待核问题与报告覆盖度一屏读懂当前进度，逐项可深链到对应 Tab 复核。自动流水线可在专题设置中关闭，checkpoint 阶段（实体归并、矛盾确认）仍停下等人工确认。自动研判每案默认问 8 题，可用 `MINI_AGENT_AUTO_INQUIRY_MAX` 调整。

建议配置：

```bash
export MINI_AGENT_MAX_OUTPUT_TOKENS=8192
```

该变量影响 agent 长载荷（逐步提交结构化结论等）的稳定性；文本模型默认 max_tokens 过低时容易在工具参数解析上失败。

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

当前文档入口：

- [项目状态与开发约定](AGENTS.md)
- [文档索引](docs/README.md)
- [项目宣称与诚实边界](docs/claims-and-limitations.md)
- [技术总结报告](docs/report/技术总结报告-2026-07-10.md)
- [真实模型端到端复测](docs/report/2026-07-10-real-model-e2e.md)
- [课程答辩材料](docs/delivery/README.md)

## Verification

```bash
pnpm typecheck
pnpm test:run
pnpm check
pnpm build
```

2026-07-10 验证结果：106 个测试文件通过、1 个跳过；927 个测试通过、3 个跳过；core/server/web 三包构建通过。三个跳过用例均依赖显式外部模型条件：两个 DashScope 在线 smoke 和一个 LLM-dependent benchmark 指标用例。
