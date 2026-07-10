> **⚠️ 历史存档（2026-07-03 快照）**：本文件描述的功能范围与里程碑编号可能已过时，仅作历史参考。项目当前状态与唯一现行入口见仓库根 [AGENTS.md](../../AGENTS.md)。

# 项目交接文档

**交接日期**: 2026-07-03  
**当前状态**: Phase 1-2 已完成，Phase 3 待定  
**上下文**: 本文档用于新对话快速了解项目背景和当前状态  

---

## 快速概览

### 项目目标

改进情报分析工作台的三个核心模块，降低用户"不知所措"的门槛：
1. **溯源问答** - 用户不知道问什么 → 智能问题推荐
2. **研判结论** - 手动提升流程割裂 → 批量生成建议
3. **报告复核** - 空白编辑器门槛高 → 自动草稿生成

### 已完成工作

✅ **Phase 1** (规则引擎): 问题推荐 + Finding 批量提升  
✅ **Phase 2** (LLM 增强): 上下文服务 + 提示词服务 + LLM 问题生成 + 报告草稿  
⏸️ **Phase 3** (体验优化): 待定（建议先收集真实用户数据）

### 核心成果

- 814 个测试通过、3 个跳过（含新增/修复回归测试）
- TypeScript 零错误
- 零功能回归
- 3 个新服务（Suggestion, Context, Prompt）
- 5 个新 API 端点

---

## 项目结构

### 关键文档位置

```
mini-agent/
├── docs/
│   ├── decisions/
│   │   ├── 2026-07-03-intelligent-workflow-automation.md  # 决策文档
│   │   └── implementation-roadmap-2026-07-03.md           # 实施路线图（现已归档）
│   └── reports/
│       └── 2026-07-03-phase1-2-implementation-report.md  # 完整实施报告（现已归档）
├── packages/
│   ├── server/src/
│   │   ├── suggestion/           # Phase 1: 建议服务
│   │   ├── context/              # Phase 2: 上下文服务
│   │   ├── prompt/               # Phase 2: 提示词服务
│   │   └── routes/suggestions.ts # 新增 API 路由
│   └── web/src/pages/CaseWorkbench/panels/
│       ├── InquiryPanel.tsx      # 问题推荐 UI
│       ├── FindingsPanel.tsx     # Finding 建议 UI
│       └── ReportPanel.tsx       # 报告草稿 UI
└── README.md
```

### 代码变更摘要

**新增文件** (8 个):
- `suggestion-service.ts` (350 行) - 核心建议引擎
- `context-service.ts` (280 行) - 上下文聚合
- `prompt-service.ts` (120 行) - 提示词管理
- `routes/suggestions.ts` (80 行) - API 路由
- 4 个测试文件 (980 行)

**修改文件** (8 个):
- `report-service.ts` (+150 行) - 报告草稿生成
- `prompt-store.ts` (+60 行) - 新增 3 个提示词模板
- 3 个前端面板 (+300 行)
- `app.ts`, `api.ts` 等配置文件

---

## 架构要点

### 服务依赖图

```
SuggestionService (Phase 1 核心)
  ├── InquiryService (查询问答)
  ├── FindingService (创建 Finding)
  ├── ContradictionService (查询矛盾)
  ├── ElementGraphService (查询要素图谱)
  ├── ContextService (Phase 2，上下文聚合)
  ├── PromptService (Phase 2，提示词)
  └── LlmDeps (Phase 2，LLM 调用)

ReportService (Phase 2 扩展)
  ├── FindingService
  ├── ContradictionService
  ├── ElementService
  ├── MaterialService
  ├── ContextService (Phase 2)
  ├── PromptService (Phase 2)
  └── LlmDeps (Phase 2)

ContextService (Phase 2 新增)
  - 按用途聚合上下文
  - Token 预算管理
  - 30 秒缓存

PromptService (Phase 2 新增)
  - 集成 PromptStore
  - 模板变量渲染
  - 审计日志
```

### API 端点

**新增 5 个端点**:
```
GET  /api/cases/:id/suggestions/questions          # 规则引擎问题
GET  /api/cases/:id/suggestions/questions-llm      # LLM 增强问题
GET  /api/cases/:id/suggestions/findings           # Finding 建议
POST /api/cases/:id/suggestions/findings/:id/apply # 采纳建议
POST /api/cases/:id/report/auto-draft              # 生成报告草稿
```

### 关键设计决策

1. **矛盾类 Finding 建议门槛**
   - 原计划：置信度 >0.7 直接建议
   - 实际实现：需先被保密员/管理员 acknowledge（非 dismiss）
   - 理由：避免绕过矛盾审查流程

2. **LLM 降级策略**
   - 规则引擎作为保底（始终可用）
   - LLM 失败/未配置 → 静默降级
   - 用户友好的占位符文本

3. **建议不持久化**
   - 每次请求实时计算
   - 降低存储复杂度
   - suggestionId 仅用于审计关联

---

## 技术要点

### 测试策略

**测试覆盖**:
- 单元测试：48 个（规则引擎、上下文、提示词、LLM mock）
- 集成测试：5 个（完整建议 → 采纳流程）
- 回归测试：764 个（所有既有功能）

**运行测试**:
```bash
cd /Users/rustypiano/项目/mini-agent
pnpm test                    # 全部测试
pnpm test suggestion         # 仅建议服务
pnpm test context            # 仅上下文服务
pnpm run typecheck           # TypeScript 检查
```

### 性能基准

| 操作 | 目标 | 实际 |
|------|------|------|
| 问题建议（规则） | < 1s | ~200ms |
| 问题建议（LLM） | < 3s | 待目标模型复测 |
| Finding 建议 | < 2s | ~500ms |
| 报告草稿（模板） | < 5s | ~1s |
| 报告草稿（LLM） | < 10s | 待目标模型复测 |

### 审计事件

**新增事件类型**:
- `suggestion.questions` - 问题建议生成
- `suggestion.findings` - Finding 建议生成
- `suggestion.apply` - 建议采纳（关联 suggestionId 和 source）
- `prompt.access` - 提示词访问
- `report.llm.summary` - 报告概要 LLM 生成
- `report.llm.conclusion` - 报告结论 LLM 生成

---

## 常见问题

### Q1: 如何测试新功能？

**问题推荐**:
1. 启动服务：`cd packages/server && pnpm dev`
2. 启动前端：`cd packages/web && pnpm dev`
3. 打开专题，进入"溯源问答"页面
4. 应看到 5-8 个动态生成的问题卡片
5. 点击"深度分析"切换到 LLM 模式（需配置 LLM）

**Finding 建议**:
1. 先在"溯源问答"中完成几个问答（确保有引用支撑）
2. 进入"研判结论"页面
3. 顶部应显示建议列表
4. 点击"全部采纳"或逐条"采纳"

**报告草稿**:
1. 先核准几个 Finding（review_status = 'approved'）
2. 进入"报告复核"页面
3. 点击"🪄 自动生成草稿"
4. 草稿会包含 5 个章节（LLM 章节需配置）

### Q2: LLM 如何配置？

查看 `packages/server/src/app.ts` 中的 `guardModelAdapter` 配置：
- 使用现有的 `inquiry-service.ts` 模式
- 需要配置 `ModelAdapter` 和 `OfflineGuard`
- 未配置时自动降级到规则引擎/模板

### Q3: 如何查看审计日志？

```bash
# 查看建议相关事件
grep 'suggestion\.' data/cases/*/audit.jsonl

# 查看 LLM 调用事件
grep 'report\.llm\.' data/cases/*/audit.jsonl

# 统计采纳率（手动）
grep 'suggestion.apply' data/cases/*/audit.jsonl | wc -l
```

### Q4: Phase 3 何时启动？

**建议流程**:
1. 先完成部署前验证，并在灰度环境试点 Phase 1-2
2. 收集 2-4 周真实用户使用数据
3. 测量指标：
   - 建议采纳率（目标 >60%）
   - 用户反馈（"不知所措"占比）
   - LLM 生成质量
4. 根据数据决定 Phase 3 优先级

**Phase 3 内容**:
- FeedbackService（自动化采纳率统计）
- AI 助手（进度分析 + 主动提示）
- 提示词优化（基于反馈数据）

### Q5: 如何回滚？

```bash
# 1. 备份已打 tag
git checkout backup-before-phase1-2

# 2. 重新安装依赖
pnpm install

# 3. 重新构建
pnpm run build

# 4. 重启服务
pm2 restart mini-agent-server
```

---

## 下一步行动

### 立即可做

1. **审查代码**
   - 阅读 `docs/archive/2026-07-03-phase1-2-implementation-report.md`
   - 检查 `packages/server/src/suggestion/suggestion-service.ts`
   - 检查前端面板代码

2. **测试功能**
   - 按上述 Q1 步骤测试三个模块
   - 验证降级策略（禁用 LLM 后测试）
   - 检查审计日志是否正常记录

3. **准备部署**
   - 确认环境检查清单（见实施报告）
   - 配置 LLM（如需）
   - 备份当前数据

### 如需继续开发

1. **Phase 3 实施**
   - 参考 `docs/archive/implementation-roadmap-2026-07-03.md`
   - 先实施 FeedbackService
   - 再考虑 AI 助手

2. **优化改进**
   - 关系问题去重（与已有问答对比）
   - 提示词调优（基于反馈）
   - 性能优化（缓存策略）

3. **新功能**
   - 基于真实用户反馈决定方向

---

## 联系与支持

### 关键决策记录

所有架构决策和技术选型理由都记录在：
- `docs/decisions/2026-07-03-intelligent-workflow-automation.md`

### 代码审查要点

如需 code review，重点关注：
1. 规则引擎逻辑（`suggestion-service.ts` 中的 4 类规则）
2. LLM 降级策略（所有 `try-catch` 块）
3. 审计日志完整性（每个关键操作）
4. 前端用户体验（建议列表 UI）

### 技术债务

当前已知的技术债务：
1. 采纳率统计需手动（Phase 3 FeedbackService 解决）
2. 关系问题去重未实现（低优先级）
3. ContextService 在报告生成中预留但未使用（架构一致性）

---

## 2026-07-07 阶段三交付

> 与本文档上文的 Phase 1-2（建议/上下文/提示词服务）是不同批次的工作，编号也不同——这里的"阶段一/二/三"
> 沿用根目录 `implementation-notes.md` 与 `docs/plans/2026-07-06-phase3-guided-autopilot-plan.md` 的计划文档编号，
> 不是本文档第 223 节"Phase 3 待定"里规划的 FeedbackService/AI 助手（那部分仍待定，未开工）。
> 阶段一（agent 成功率修复）、阶段二（透明化事件流）已先于阶段三合入，均见 `implementation-notes.md`。

**产品主张**：把一份案卷变成一份全覆盖、可审计的核验报告——上传即自动加工与研判，人从"提问者"变成"复核者"。四个里程碑（M1–M4）已全部合入 main，M5（本次）完成 demo 种子适配与文档收尾：

- **M1 自动流水线**：素材全部加工完成（done/failed）后，`task/autopilot-service.ts` 自动创建/推进核验 TaskRun，并预跑三个不需人工输入的执行体——要素抽取 → 矛盾检测 → 自动研判；checkpoint 阶段（实体归并、矛盾确认）仍停下等人工确认。任一执行体产物已在盘上则幂等跳过，不会重复触发。
- **M2 研判简报**：进入专题默认首屏即"研判简报"（`brief/brief-service.ts` + BriefPanel）——案情概览（LLM 生成，逐句绑定引用，不可用时降级为纯统计）、时间线、关键实体、矛盾、待核问题、报告覆盖度一屏读懂案情，逐项深链到对应 Tab。`brief.json` 只缓存派生快照，任务阶段/自动研判进度每次现算叠加。
- **M3 自动研判批处理**：`inquiry/auto-inquiry-service.ts` 复用既有构件——出题走 suggestion 服务、逐题走与手动 `POST /inquiries` 相同的 agent 问答，产物照常入 Finding 候选池；进度落 `cases/<id>/auto-inquiry.json`，简报现算叠加显示逐题状态，可中途取消。
- **M4 报告覆盖率仪表**：`report/coverage.ts` 固定五节（背景与素材概况/关键时间线/矛盾核验/研判结论/未决事项），每节给可判定的证据要求 + 人话缺口明细 + 深链引导；纯展示与引导，**不新增导出硬门禁**（既有引用完整性门禁不变）。

**评测入口**：

```bash
pnpm eval:agent                    # 默认单题 180s 超时，10 题固定题集
pnpm eval:agent -- --timeout 300   # 广度综合题（timeline-1/entities-1）超 180s 时调大
```

结果 JSON（`packages/server/eval/results/*.json`）现含每题 `answer` 正文与 `claims` 摘要，可离线核对内容质量，不必只看 finalize/error 率。

**已知限制**：

1. **增量素材不自动重分析**：已分析专题（elements.json/contradictions.result.json 已存在）追加新素材后，autopilot 按"产物已存在"幂等跳过，不会自动重新分析新素材；需人工在对应 Tab 重跑 job。
2. **自动研判批次幂等语义**：`auto-inquiry.json` 只要存在（含 `cancelled`/`partial` 状态的批次）即视为"已跑过"，autopilot 不会自动重跑；需重跑走手动 `POST /cases/:id/jobs/auto-inquiry/start`。
3. **"未决事项"口径**：报告覆盖率的"未决事项"节以自动研判批次为准——批次从未运行过就判该节未满足（明细"自动研判尚未运行"），这是引导用户去跑自动研判、闭合待核问题的软提示，不是数据错误，也不影响报告导出。

**Demo 种子**（`packages/server/src/demo/seed.ts`，`MINI_AGENT_DEMO=1`）：演示专题预置了闭环的自动研判批次与矛盾处置台账，报告覆盖率开箱即 4/5——唯一缺口是故意留 1 条未处置的矛盾（`ct-unload-status`，卸货完成状态，是 7 条矛盾里唯一没有被任何已核准 Finding 引用覆盖的一条），用于现场演示"处置矛盾"这个动作。细节见 `implementation-notes.md` 「阶段三 M5」小节。

**验证**：`pnpm vitest run packages/server`（530 passed / 1 skipped，61 文件）+ server typecheck（含 eval tsconfig）全绿。真模型端到端演练（新建专题→上传→自动跑→简报→报告导出）建议在部署前用本地/内网模型跑一遍。

---

**文档维护者**: Claude (AI 协调者)  
**最后更新**: 2026-07-07  
**版本**: v1.0
