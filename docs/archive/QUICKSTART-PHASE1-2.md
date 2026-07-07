> **⚠️ 历史存档（2026-07-03 快照）**：本文件描述的功能范围与里程碑编号可能已过时，仅作历史参考。项目当前状态与唯一现行入口见仓库根 [AGENTS.md](../../AGENTS.md)。

# Phase 1-2 快速上手指南

**适用场景**: 新对话需要快速了解项目当前状态  
**阅读时间**: 5 分钟  

---

## 🎯 一句话概括

已完成智能工作流自动化的 Phase 1（规则引擎）和 Phase 2（LLM 增强），为溯源问答、研判结论、报告复核三个模块添加了智能推荐和自动生成功能。

---

## 📚 关键文档（按阅读顺序）

### 1. 交接文档（必读）
**文件**: `docs/HANDOVER.md`  
**内容**: 项目背景、架构要点、常见问题、下一步行动  
**阅读时间**: 10 分钟

### 2. 实施报告（详细参考）
**文件**: `docs/reports/2026-07-03-phase1-2-implementation-report.md`  
**内容**: 完整的实施细节、代码变更统计、测试覆盖、部署指南  
**阅读时间**: 20 分钟

### 3. 决策文档（架构理解）
**文件**: `docs/decisions/2026-07-03-intelligent-workflow-automation.md`  
**内容**: 为什么做这些改动、方案对比、预期效果、验收标准  
**阅读时间**: 15 分钟

### 4. 实施路线图（进度追踪）
**文件**: `docs/decisions/implementation-roadmap.md`  
**内容**: 三阶段计划、任务分解、质量检查点  
**阅读时间**: 10 分钟

---

## 🚀 5 分钟快速理解

### 改动内容

| 模块 | 改进前 | 改进后 |
|------|--------|--------|
| **溯源问答** | 空白输入框 | 8 个智能推荐问题 |
| **研判结论** | 手动提升 | 批量生成建议 |
| **报告复核** | 空白编辑器 | 一键生成草稿 |

### 核心成果

- ✅ 814 个测试通过、3 个跳过（含新增/修复回归）
- ✅ TypeScript 零错误
- ✅ 零功能回归
- ✅ 3 个新服务
- ✅ 5 个新 API 端点

### 文件位置

```
packages/server/src/
├── suggestion/           # Phase 1: 建议服务
├── context/             # Phase 2: 上下文服务
├── prompt/              # Phase 2: 提示词服务
└── routes/suggestions.ts

packages/web/src/pages/CaseWorkbench/panels/
├── InquiryPanel.tsx      # 问题推荐 UI
├── FindingsPanel.tsx     # Finding 建议 UI
└── ReportPanel.tsx       # 报告草稿 UI
```

---

## 🧪 快速测试

### 测试问题推荐
```bash
# 1. 启动服务
cd packages/server && pnpm dev

# 2. 启动前端
cd packages/web && pnpm dev

# 3. 打开专题 → 溯源问答页面
# 应看到 5-8 个问题卡片

# 4. 点击"深度分析"（需配置 LLM）
```

### 测试 Finding 建议
```bash
# 1. 完成几个问答（确保有引用支撑）
# 2. 进入研判结论页面
# 3. 应看到建议列表
# 4. 点击"全部采纳"或逐条"采纳"
```

### 测试报告草稿
```bash
# 1. 核准几个 Finding
# 2. 进入报告复核页面
# 3. 点击"🪄 自动生成草稿"
# 4. 应生成包含 5 个章节的草稿
```

---

## 🔍 验证清单

在新对话中继续工作前，请确认：

- [ ] 阅读了 `docs/HANDOVER.md`
- [ ] 了解 3 个新服务的职责（Suggestion, Context, Prompt）
- [ ] 知道 5 个新 API 端点的作用
- [ ] 理解 LLM 降级策略
- [ ] 清楚审计日志的新事件类型
- [ ] 知道如何运行测试（`pnpm test`）
- [ ] 了解 Phase 3 是可选的（建议先收集数据）

---

## 💡 常见任务

### 查看审计日志
```bash
grep 'suggestion\.' data/cases/*/audit.jsonl
```

### 运行测试
```bash
pnpm test                # 全部测试
pnpm test suggestion     # 仅建议服务
pnpm run typecheck       # TypeScript 检查
```

### 查看提示词
```bash
# 查看所有提示词模板
grep -A 10 'suggest-questions' packages/server/src/admin/prompt-store.ts
grep -A 10 'generate-summary' packages/server/src/admin/prompt-store.ts
```

### 检查服务依赖
```bash
# SuggestionService 的构造函数参数
grep -A 20 'constructor(' packages/server/src/suggestion/suggestion-service.ts
```

---

## 🎯 下一步建议

### 如果是代码审查
1. 重点看 `suggestion-service.ts` 的规则引擎
2. 检查 LLM 降级策略的 try-catch
3. 验证审计日志完整性

### 如果是继续开发
1. 先完成部署前验证，并在灰度环境试点 Phase 1-2
2. 测量采纳率（目标 >60%）
3. 根据数据决定 Phase 3 优先级

### 如果是新功能
1. 阅读决策文档了解架构
2. 遵循现有服务模式
3. 添加相应的测试覆盖

---

## 📞 需要帮助？

- **架构问题**: 阅读 `docs/decisions/2026-07-03-intelligent-workflow-automation.md`
- **实施细节**: 阅读 `docs/reports/2026-07-03-phase1-2-implementation-report.md`
- **代码位置**: 参考 `docs/HANDOVER.md` 的"项目结构"章节
- **测试失败**: 检查 `packages/server/tests/` 下的测试文件

---

**最后更新**: 2026-07-03  
**维护者**: Claude (AI 协调者)
