<!--
  这是本项目的 Agent 上下文文档，供 AI 助手在每个新 session 快速进入状态。
  它由 .claude/settings.json 的 SessionStart 钩子在每次会话开始时自动注入上下文，
  所以你（新 session 的 Claude）现在正在读它 —— 不需要用户重新介绍背景。
  **维护约定见文末「## 维护约定」，请在里程碑完成 / 提交前后主动更新本文件。**
  面向人也可读：这是项目的单一onboarding入口。最后更新：2026-07-10。
-->

# AGENTS.md — Intel Workbench 项目上下文

## 一句话

离线/内网环境的**多源线索核验工作台**：把一份案卷（文档/音视频/图像）变成一份**全覆盖、可审计的核验报告**。系统主动加工、检索、检测矛盾、生成研判简报，人从"提问者"变成"复核者"。底层是自研 Agent Runtime，不是套壳 chatbot。课程作业，需契合实际、有创新、有工作量。

## 架构与技术栈

pnpm monorepo，三包：

- `packages/core` — 自研 Agent Runtime（`mini-agent`）：agent loop、工具系统（zod 校验）、流式、可恢复 JSONL 会话、run trace、skills、OpenAI-compatible 模型适配器。CLI 亦在此。
- `packages/server` — Intel Workbench API（`@intel-workbench/server`）：鉴权、专题、素材加工、agentic RAG 问答（引用台账）、矛盾检测、要素/时间线、研判简报、报告、哈希链审计、零外发守卫（OfflineGuard）。**扁平文件持久化**（cases/<id>/…），无数据库。
- `packages/web` — React 19 工作台界面：登录、专题工作台（研判简报为默认首屏）、素材、要素图、矛盾、补充核验（流式活动流+证据台账双栏）、结论核验、报告、审计。手写 CSS design token，无组件库。

模型：文本走 OpenAI-compatible（演示用云端 DeepSeek，env 已配 `dev.env.sh`）。媒体槽位（ASR/OCR/VLM/Embedding）优先本地/内网；未配置则降级，默认 embedding 是 8 维哈希 mock（无语义）。

## 当前进度（截至 2026-07-10）

三个阶段已完成并按里程碑提交（`git log` 可见，均 Co-Authored-By Claude）：

- **阶段一 · Agent 成功率修复**：问答错误率 30%→0%。根因是 `finalize_answer` 一次性大 JSON 被模型默认 4096 token 截断、且 core 对解析失败直接判死。修复：`add_claim` 逐条提交 + `finalize_answer` 空参封卷；core 解析失败改为救援→喂回模型重试；打通 `MINI_AGENT_MAX_OUTPUT_TOKENS`。评测入口 `pnpm eval:agent`（固定 10 题，前后对比留档 packages/server/eval/results/）。
- **阶段二 · 研判过程透明化**：补充核验实况区重构为「活动流 + 证据台账」双栏（方向 B），像 Claude Code 一样展示工具调用、思考、引用生长、预算。事件协议 v2（11 种事件 + 13 工具摘要器 + reasoning 思维链透传）。深度模式并入流式通道。
- **阶段三 · 目标驱动工作台**（计划见 `docs/plans/2026-07-06-phase3-guided-autopilot-plan.md`）：M1 自动流水线（素材加工完成零点击自动跑要素→矛盾→自动研判）；M2 研判简报（专题默认首屏，六板块 + LLM 概览逐句引用校验 + brief.json 缓存降级）；M3 自动研判批处理（系统出题→逐题跑→候选入池）；M4 报告覆盖率仪表（五节模板，只引导不加硬门禁）；M5 demo 种子、文档和首轮真模型彩排。
- **全链路可靠性加固（2026-07-10，已提交）**：修复 core 会话/技能隔离、取消与跨进程写锁；收紧报告版本绑定、鉴权会话吊销、审计链和引用进入最终结论的条件；矛盾检测增加时态/时间锚定与大 JSON 二分重试；自动研判问题改为证据落地的中性开放问题；上传、自动流水线、简报、权限与前端状态统一按持久化事实显示。真实模型隔离专题已完成上传→加工→矛盾→自动研判→Finding→报告审批/导出链路；简报概览模型仍有一次不可解析 JSON，已诚实降级且未覆盖其他实时状态。

**下一步候选**：用固定标注集复测矛盾检测 F1（本轮策略更保守，先验证召回）；约束简报概览结构化输出；修复/重装本机 Browser 插件后补渲染态 UI 彩排；过程持久化回放（run_id 已具备）。当前答辩脚本、架构/评测速览和必答问题已整理到 `docs/delivery/`。

## 关键约定与红线（改代码前必读）

- **诚实边界**（现行口径见 `docs/claims-and-limitations.md`）：系统拒绝未接地引用并阻止未验证内容进入可采纳结论，但**禁止**声称"显著优于大模型直出""完全防幻觉""绝对零外发"或"审计绝对不可篡改"。功能已铺得够开，**收敛主线，勿再加新功能面**。
- 演示：`MINI_AGENT_DEMO=1` 起服务用固定演示专题。Web 对小文件使用单次 JSON 批量上传；大文件逐个流式上传时使用 defer/settle 协议，全部落盘后才触发自动流水线。API 调用方也必须遵守同一批次收口语义。
- `MINI_AGENT_MAX_OUTPUT_TOKENS=8192` 已写入 dev.env.sh，长载荷（finalize/矛盾抽取/概览）稳定性依赖它。自动研判每案默认 8 题，`MINI_AGENT_AUTO_INQUIRY_MAX` 可调。
- 引用接地是硬机制：`cite` 要求原文逐字子串 + sha256 匹配，答案只能由已验证引用构成；归一化模糊定位是空白剔除（非折叠）。
- 覆盖率五节口径见 `packages/server/src/report/coverage.ts`（高置信矛盾阈值 0.75，与导出闸一致）。

## 如何运行与验证

```bash
pnpm install
pnpm check                       # typecheck + 全量测试（当前 927 通过、3 跳过）
source dev.env.sh                # 载入云端模型 env（含 MAX_OUTPUT_TOKENS）
MINI_AGENT_DEMO=1 pnpm dev:server
pnpm dev:web                     # 浏览器打开工作台
pnpm eval:agent -- --label X     # agent 成功率评测（--timeout 秒 可调）
```

演示账号：operator/operator123456（机密）、security/security123456（绝密）、admin/admin12345678（绝密）。彩排数据在 `packages/server/cases/演练2-夜间转运线索核验`。

## ⚠️ 里程碑编号消歧（历史文档里有多套「M1-M5」「阶段三」互相撞车）

仓库历史上有多代编号，**只有下面「当前」这套算数**，读旧文档遇到同名编号别对号入座：

| 编号出处 | 指什么 | 状态 |
| --- | --- | --- |
| **阶段一/二/三**（本文件、implementation-notes.md） | 一=成功率修复；二=透明化；三=目标驱动工作台（M1 自动流水线/M2 简报/M3 自动研判/M4 覆盖率/M5 彩排） | **当前，已交付** |
| **全链路可靠性加固（2026-07-10）** | 对 core/server/web 的正确性、安全性、真实模型链路做集中收口 | **已提交** |
| 阶段 1/2/3（阿拉伯数字，archive/HANDOVER） | 建议/上下文/提示词服务；其"Phase 3"=FeedbackService | 与"阶段三"**无关**；FeedbackService **从未实现、已放弃** |
| M0-M5（intel-workbench-phase1-engineering-plan） | 一期工程脚手架里程碑（数据/汇入/问答/报告/后台） | 历史，2026-06 |
| M1-M5（rag-quality-decision-log） | RAG 大专题改造（分批/异步/前端/benchmark） | 历史，2026-06 |
| P3.0-P3.D（phase3-agent-harness-plan、architecture*.html） | 早期多模态接真技术轨（feat/intel-p3-harness 分支） | 历史，已被"阶段一/二/三"取代；P3.C 多 agent 编排明确不做 |

历史文档统一存放在 `docs/archive/`，顶部均有存档标注。当前有效导航见 `docs/README.md`。

## 关键文件

- 详细变更日志与偏离记录：`implementation-notes.md`（可靠性加固 + 阶段一~三，最权威）
- 阶段三计划：`docs/plans/2026-07-06-phase3-guided-autopilot-plan.md`
- 项目宣称与诚实边界：`docs/claims-and-limitations.md`
- 真实模型复测：`docs/report/2026-07-10-real-model-e2e.md`
- 课程交付材料：`docs/delivery/`
- 引用台账工具：`packages/server/src/inquiry/intel-harness.ts`
- 自动编排：`packages/server/src/task/autopilot-service.ts`
- 简报：`packages/server/src/brief/brief-service.ts`

## 维护约定（给未来的 Agent）

**何时更新本文件**：完成一个里程碑 / 阶段、做 git 提交前后、改变一个关键约定或架构决策时。用户不必提醒你 —— 这是你的职责。

**怎么更新**：只改「当前进度」「下一步」「关键约定」等会变的部分；保持精炼（本文件每个 session 都注入上下文，越短越省）；相对日期转绝对日期；顶部注释的「最后更新」改成当天。细节仍写进 `implementation-notes.md`，本文件只留导航与状态。

本文件是单一 onboarding 入口。个人记忆 `~/.claude/.../memory/course-project-context.md` 指向这里，避免两处漂移。
