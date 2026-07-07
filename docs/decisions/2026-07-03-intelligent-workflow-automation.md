# 智能工作流自动化决策文档

**日期**: 2026-07-03  
**状态**: 阶段 1/2 已实施；阶段 3（FeedbackService）未实施、已放弃（2026-07-07 核实，全仓 grep 零命中）  
**决策者**: 开发团队  

> **编号提示（2026-07-07）**：本文件的「阶段 1/2/3」是本文自身的建议引擎/上下文聚合/AI 助手体系编号，与当前项目「阶段一/二/三」（成功率修复/透明化/目标驱动工作台，见根 `AGENTS.md`）无关，勿对号入座。

---

## 背景

综合代码审查发现，溯源问答、研判结论、报告复核三个核心模块存在用户引导不足的问题：

1. **溯源问答**：用户面对空白输入框，不知道问什么
2. **研判结论**：需手动从问答结论提升为 Finding，流程割裂
3. **报告复核**：需手动选择 Finding、编写正文，门槛高

用户反馈："拿到系统会比较不知所措，自动化程度还不够"

---

## 架构评估

### 当前架构优势

1. **清晰的服务层分离** - 每个领域服务独立，易于扩展
2. **已有 RuntimeAgent 基础设施** - 溯源问答和矛盾检测已验证 Agent 可行性
3. **结构化数据存储** - JSON + 明确 schema，Agent 可读写
4. **引用完整性校验** - 三层验证机制防止幻觉引用
5. **审计链完整** - 所有操作留痕，符合情报分析合规要求

### 架构短板

1. **缺少专门的 Suggestion/Recommendation 层** - 无法区分"已完成"和"建议做"
2. **LLM 调用分散** - 提示词管理不统一，难以优化
3. **缺少上下文聚合层** - 每个 Agent 任务重复收集上下文
4. **缺少反馈循环机制** - 无法学习用户偏好

**架构就绪度评分**: ⭐⭐⭐⭐ (4/5)

---

## 方案对比

### 方案 A：智能引导式工作流（✅ 已选择）

**核心思路**：
- 问题推荐引擎（规则 + LLM）
- Finding 批量生成
- 报告自动草稿

**优势**：
- 用户保留最终控制权
- 规则引擎稳定可预测
- 适合专业分析师

**实施周期**：2-3 周

### 方案 B：AI 协作助手

**核心思路**：对话式 AI 助手贯穿整个流程

**优势**：
- 学习曲线极低
- 适合新手用户

**劣势**：
- 开发工作量大（4-6 周）
- LLM 调用成本较高

**决策**：暂不采用，待方案 A 验证后考虑

---

## 实施计划

### 阶段 1：快速见效（1-2 周）- 当前阶段

#### 1.1 溯源问答 - 问题推荐引擎（规则驱动）

**功能**：
- 基础事实问题（固定模板）
- 基于矛盾的问题（规则生成）
- 基于共现关系的问题（规则生成）

**技术方案**：
```typescript
// 新增服务：SuggestionService
interface QuestionSuggestion {
  category: 'basic' | 'timeline' | 'relationship' | 'contradiction' | 'verification';
  question: string;
  rationale: string;
  priority: number; // 1-5
}
```

**预期采纳率**: 60-70%

#### 1.2 研判结论 - 一键批量提升

**功能**：
- 从高质量问答结论自动提取 Finding 建议
- 前端展示建议列表 + 批量采纳按钮

**技术方案**：
```typescript
interface FindingSuggestion {
  source: 'inquiry' | 'contradiction' | 'element-timeline';
  conclusion: string;
  supporting_citations: Citation[];
  confidence: number;
  reasoning: string;
}
```

**预期采纳率**: 80-90%

### 阶段 2：智能升级（2-3 周）

#### 2.1 报告复核 - 自动草稿生成

**功能**：
- 基于已核准 Findings 生成结构化草稿
- 模板驱动 + 少量 LLM 生成（概要、结论）

#### 2.2 溯源问答 - LLM 增强问题生成

**功能**：
- 基于材料摘要生成开放式问题
- 问题去重和优先级排序

### 阶段 3：体验优化（可选，3-4 周）

> 未实施、已放弃（2026-07-07 核实，`FeedbackService` 全仓 grep 零命中）。

#### 3.1 AI 助手 - 流程主动引导

**功能**：
- 分析进度，主动提示下一步
- 对话式交互

---

## 架构改进

### 新增服务

#### SuggestionService（核心）

**职责**：
- 聚合来自各服务的建议
- 统一建议格式和优先级
- 提供批量操作接口

**API**：
```typescript
class SuggestionService {
  async suggestAll(caseId: string): Promise<SuggestionBundle>;
  async suggestQuestions(caseId: string): Promise<QuestionSuggestion[]>;
  async suggestFindings(caseId: string): Promise<FindingSuggestion[]>;
  async suggestReportSections(caseId: string): Promise<ReportSectionSuggestion[]>;
}
```

#### ContextService（辅助）

**职责**：
- 按用途聚合专题上下文
- 按 token 预算裁剪
- 避免重复上下文收集

**API**：
```typescript
class ContextService {
  async buildContext(
    caseId: string,
    purpose: 'suggest-questions' | 'generate-report' | 'verify-claims',
    options?: { maxTokens?: number }
  ): Promise<AgentContext>;
}
```

#### FeedbackService（长期，未实施、已放弃——见文首状态更新）

**职责**：
- 记录建议采纳/忽略反馈
- 统计采纳率
- 为提示词优化提供数据

---

## 预期成果（3 个月后）

### 用户体验指标

| 指标 | 当前 | 目标 | 提升 |
|------|------|------|------|
| 新建专题到首次问答 | 5-10 分钟 | < 1 分钟 | 80-90% |
| 问答到生成 Finding | 3-5 分钟/条 | < 30 秒 | 90% |
| Finding 到报告草稿 | 15-30 分钟 | < 5 分钟 | 70-80% |
| "不知所措"反馈占比 | 预计较多 | < 10% | - |

### 系统效率指标

| 指标 | 预期值 |
|------|--------|
| 建议采纳率（阶段 1） | 60-70% |
| 建议采纳率（阶段 2） | 75-85% |
| 自动化覆盖率 | 70-80% |
| 每专题 LLM 成本增加 | $0.5-1 |
| 平均分析时长 | 从 2-4 小时降至 30-60 分钟 |

---

## 风险与缓解

### 风险 1：建议采纳率低于预期

**概率**: 中  
**影响**: 高  
**缓解措施**:
- 阶段 1 使用规则引擎保底（可预测）
- 提供"忽略"按钮，避免干扰
- 收集反馈数据，持续优化

### 风险 2：LLM 生成质量不稳定

**概率**: 中  
**影响**: 中  
**缓解措施**:
- 使用结构化输出（JSON Schema）
- 多次重试 + 降级策略
- 人工审核闸门

### 风险 3：增加系统复杂度

**概率**: 低  
**影响**: 中  
**缓解措施**:
- 保持服务层独立
- 建议层仅为聚合，不改变原有逻辑
- 充分测试

---

## 验收标准

### 阶段 1 验收（1-2 周后）

- [x] 溯源问答页面显示 5-8 个推荐问题
- [x] 推荐问题基于当前材料动态生成（矛盾、关系、时间线）
- [x] 问答结论旁边显示"提升为研判结论"按钮（既有功能，本阶段未改动）
- [x] 研判结论页面显示建议列表（来源标注：问答/矛盾/时间线）
- [x] 支持批量采纳建议
- [ ] 采纳率 > 60%（基于内部测试）—— 需产品/分析员实际使用后统计，规则引擎已就绪但无使用数据
- [x] TypeScript 编译通过
- [x] 所有测试通过
- [x] 审计日志记录建议生成和采纳动作

### 阶段 2 验收（额外 2-3 周）

- [ ] 报告页面支持"自动生成草稿"
- [ ] 草稿包含：概要、时间线、关键发现、矛盾说明、结论
- [x] LLM 生成的问题相关性 > 70%（机制已就绪：`suggestQuestionsWithLLM` + 结构化 JSON 输出 + 未配置/失败均降级；
      "相关性 > 70%"需人工评测真实生成结果，本阶段未做，见下方"遗留观察项"）
- [ ] 报告草稿可用性 > 60%（需少量修改即可提交）

---

## 阶段 1 实施说明（2026-07-03）

### 已交付

- **`SuggestionService`**（`packages/server/src/suggestion/suggestion-service.ts`）：规则驱动，不调用 LLM。
  - `suggestQuestions`：固定基础问题（2 条）+ 矛盾派生（同实体+属性去重，置信度 >0.7，最多 3 条）+
    时间线派生（要素图谱时间点 ≥3 个时，取已锚定时间点首尾生成跨度问题，锚定点不足 2 个则退回全部时间点首尾）+
    关系派生（要素图谱共现权重最高的边，最多 3 条），按 priority 降序，封顶 8 条。
  - `suggestFindings`：来源一（问答）取 `support_status === "supported"` 且引用数 ≥2 的结论；
    来源二（矛盾）取置信度 >0.7 **且已被保密员/管理员处理为非 dismissed** 的矛盾（比原计划新增"已处理"门槛——
    未处理的矛盾不该抢先变成结论，见下方"与原计划的偏差"）；来源三（时间线）取被引用 ≥3 次的时间锚点。
    已存在同结论文本的 Finding 不再重复建议。
  - `applyFinding`：委托 `FindingService.create` 落盘（复用其全部校验：引用完整性、置信度范围等），
    额外记一条 `suggestion.apply` 审计（关联 `suggestionId` 与 `source`，供后续统计采纳率）。
  - 建议本身**不持久化**——每次请求即时计算；`FindingSuggestion.id` 仅为本次响应内的前端 key /
    审计关联标识，不是数据库主键。
- **路由**：`packages/server/src/routes/suggestions.ts`，挂载于 `/api/cases/:id/suggestions/*`（`GET questions`、
  `GET findings`、`POST findings/:suggestionId/apply`），已接入 `app.ts` 服务装配与 `routes/api.ts` 的 `_routes` 自描述列表。
- **前端**：
  - `InquiryPanel.tsx`：新增 `QuestionSuggestionCards` 组件，替换原静态 `INQUIRY_SUGGESTIONS` 常量；
    专题切换时拉取 `getSuggestedQuestions`，点击卡片复用既有 `handleEditQuestion` 填入输入框（不自动发送，
    保留用户最终确认权，符合决策文档"用户保留最终控制权"）。拉取失败静默降级（不阻断问答主路径）。
  - `FindingsPanel.tsx`：新增建议列表区块（`contradictions-list` 顶部），支持"全部采纳"与逐条"采纳"/"忽略"；
    "忽略"仅本地隐藏（不持久化，刷新后恢复，避免过度设计——阶段 1 无反馈存储需求）；采纳后复用 `load()` 刷新
    Finding 列表与建议列表（已落盘的建议因结论去重不会重复出现）。
  - `api.ts`：新增 `getSuggestedQuestions` / `getSuggestedFindings` / `applySuggestedFinding` 及对应类型。
- **测试**：`packages/server/tests/suggestion-service.test.ts`（17 个用例），覆盖四类问题规则的触发/不触发/去重/封顶、
  三类 Finding 规则的触发/去重/矛盾确认状态流转、`applyFinding` 成功与空结论拒绝、审计事件记录。
- `pnpm typecheck` 与全量 `vitest run`（781 通过 / 3 跳过，均为既有跳过用例）均通过。

### 与原计划的偏差（及理由）

1. **矛盾类 Finding 建议新增"已被保密员/管理员处理（非忽略）"门槛**，原计划只写"acknowledged contradictions with
   confidence > 0.7"。未处理的高置信度矛盾直接建议为 Finding 会绕过矛盾处理流程本身的把关意义；
   加此门槛后，矛盾要先经人工 acknowledge（`resolved`，可附结论备注）才会出现在 Finding 建议里，
   `dismissed` 的矛盾（人工判断非真实矛盾）则永不建议。
2. **"提升为研判结论"按钮**验收项标为已完成，但这是 `FindingsPanel.tsx` 已有功能（`claimRows` 侧栏的
   "生成研判结论"按钮），本阶段未新增改动，仅确认其与新增的建议列表不冲突。
3. 未新增独立的 `docs/architecture` 章节或 `ContextService`/`FeedbackService`——决策文档"架构改进"一节里的这两个
   服务属阶段 2/长期规划，阶段 1 验收标准未要求，遵循 CLAUDE.md"最小实现"原则暂不引入。

### 前端刷新说明

本次开工前 `packages/web` 的 `feature/frontend-refactor-opt` 分支模块化重构已合并入 `main`
（`git log` 显示 `96c8618 Merge feature/frontend-refactor-opt`），`InquiryPanel.tsx` / `FindingsPanel.tsx`
已在 `packages/web/src/pages/CaseWorkbench/panels/` 下就位，故本阶段直接在合并后的文件上开发，无需额外等待或标注阻塞。

### 遗留观察项（非本阶段范围，供阶段 2 参考）

- 采纳率数据目前只能通过 `suggestion.questions` / `suggestion.findings` / `suggestion.apply` 审计事件人工统计
  （`grep audit.jsonl` 或后续接入 `FeedbackService` 后自动化），阶段 1 未做专门的统计面板。
- `suggestQuestions` 的关系派生问题目前只取图谱边权重最高的前 3 条，未按"是否已有相关问答覆盖"去重
  （即使用户已经问过某对实体的关系，规则仍可能重复推荐）——影响应较小，阶段 2 引入 LLM 生成时可一并处理去重。

---

## 阶段 2 Task Group A 实施说明（2026-07-03）：ContextService + PromptService + LLM 增强问题生成

### 已交付

- **`ContextService`**（`packages/server/src/context/context-service.ts`）：按用途（`suggest-questions` /
  `generate-report` / `verify-claims`）聚合专题数据为 `AgentContext`（素材摘要 / 要素摘要 / 矛盾摘要 /
  问答摘要 / Finding 摘要 + 粗略 token 估算），供后续 LLM 增强功能消费。
  - 用途裁剪：素材/要素/矛盾/问答/Finding 各自有按用途区分的条数上限与摘录长度（如 `suggest-questions`
    的素材摘录截 200 字符、`verify-claims` 截 400 字符；`suggest-questions` 只带 3 条 Finding 参考避免
    诱导重复推荐已有结论、`generate-report` 带 30 条作为草稿主要输入）。
  - Token 估算：`estimateTokens` 导出为纯函数，粗略折算 1 token ≈ 4 字符（对非字符串先 `JSON.stringify`）。
  - 预算裁剪：`trimToTokenBudget`（私有）按 findings → inquiries → contradictions → elements → materials
    的顺序从数组尾部（各数组已按置信度/新鲜度/频次降序排列，故尾部即最不重要）逐条丢弃，直至落入预算；
    `materials` 至少保留 1 条。
  - 缓存：`caseId:purpose` 为键，30 秒 TTL，只缓存裁剪前的聚合结果（`cases.get` 权限校验不缓存，每次都
    实际执行，见下方"与原计划的偏差"）。
- **`PromptService`**（`packages/server/src/prompt/prompt-service.ts`）：在既有 `PromptStore`（存取 + 版本
  历史）之上加"取用"层——`getPrompt(actor, id, context?)` 委托 `promptStore.getBody` 取模板，`{key}` 变量替换
  （未提供的变量原样保留，`null`/`undefined` 渲染为空串），并记一条 `prompt.access` 审计（`id` + 是否带
  `context`），供后续提示词优化用量分析。`ManagedPromptId` 直接从 `prompt-store.ts` 重导出，不重复定义。
  - `prompt-store.ts` 的 `REGISTERED_PROMPTS` 新增 `suggest-questions` 条目（含决策文档给出的中文提示词正文，
    但 JSON schema 由 `[{"question":...}]` 调整为 `{"questions":[{"question":...}]}`，见下方"与原计划的偏差"）。
- **`SuggestionService.suggestQuestionsWithLLM`**（`packages/server/src/suggestion/suggestion-service.ts`）：
  1. 始终先算规则建议（`suggestQuestions`，阶段 1 逻辑不变），作为 LLM 未配置/失败时的兜底与合并基底。
  2. `llm.adapter` 为 `null`（文本 LLM 未配置）时直接返回规则建议，不做任何 LLM 相关调用。
  3. 已配置时：`ContextService.buildContext(actor, caseId, "suggest-questions")` 取材料摘要 + 要素 →
     `PromptService.getPrompt` 渲染 → `guardModelAdapter`（复用 `InquiryService` 同款出站授权模式）→
     `generateJson` 生成 3-5 条开放式问题（`category: "analysis"`，新增枚举值，`priority` 与 `timeline`
     同档=4）。
  4. LLM 结果与规则建议合并：按归一化问题文本（去首尾空白 + 结尾标点）去重（保留先出现者，LLM 结果排在前）、
     按 `priority` 降序重排、封顶 `maxQuestions`（默认 8，同规则引擎）。
  5. LLM 调用全程包在 `try/catch`：超时/端点未配置/JSON 解析失败均静默降级为纯规则建议，同时记一条
     `suggestion.questions.llm`（`result: "error"`，`detail.reason`）审计；成功则记 `result: "ok"` +
     `detail.count`。
- **路由**：`packages/server/src/routes/suggestions.ts` 新增 `GET /:id/suggestions/questions-llm`，已接入
  `routes/api.ts` 的 `_routes` 自描述列表。
- **前端**：
  - `api.ts`：新增 `getSuggestedQuestionsLLM`；`QuestionSuggestionCategory` 新增 `"analysis"`。
  - `InquiryPanel.tsx`：`QuestionSuggestionCards` 增加"快速推荐"/"深度分析"模式切换按钮
    （`suggestion-mode-toggle`），切换即重新拉取对应端点；拉取中显示"生成中…"，两种模式失败均静默降级
    （不阻断问答主路径，沿用阶段 1 既有降级策略）。
- **测试**：
  - `packages/server/tests/context-service.test.ts`（12 个用例）：`estimateTokens` 折算、空专题、密级访问
    拒绝、按用途的要素/素材裁剪差异、矛盾/问答排序、30 秒缓存窗口内复用与跨用途独立计算、按置信度优先保留
    的预算裁剪（含极小预算只剩 1 条素材的边界）。
  - `packages/server/tests/prompt-service.test.ts`（7 个用例）：默认透传、变量替换、未知变量保留、
    `null`/`undefined` 渲染为空、访问审计、未知 id 委托 404。
  - `packages/server/tests/suggestion-service.test.ts` 新增 `suggestQuestionsWithLLM` 描述块（8 个用例，
    用脚本化 `ModelAdapter` 模拟 LLM，不出真实网络）：未配置降级、合并去重排序封顶、问题去重（容忍中英文
    标点差异）、`maxQuestions` 生效、调用抛错降级并记错误审计、JSON 不可解析降级、成功审计计数。
- `pnpm typecheck`（含 `mini-agent` 核心构建 + `server` + `web`）与全量 `vitest run`（809 通过 / 3 跳过，
  跳过用例与阶段 1 相同）均通过。

### 与原计划的偏差（及理由）

1. **`ContextService.buildContext` / `PromptService.getPrompt` 均比任务说明的方法签名多一个 `actor: Identity`
   首参**。原始接口草案省略了它，但本仓库所有读取专题数据或落审计的服务方法都以 `actor` 作首参
   （§7.5 密级校验 + 审计落到真实用户是硬约束）——`ContextService` 内部要读取专题及其派生数据、
   `PromptService` 要在审计里记录"谁访问了提示词"，省略 `actor` 要么绕开密级校验、要么让审计的
   `user` 字段无从谈起。`ContextService.buildContext` 内部先 `cases.get(actor, caseId)` 做权限闸门
   （不缓存，每次都执行），再对其后的聚合结果按 `caseId:purpose` 缓存——避免"缓存了高密级 actor 的
   结果又被低密级 actor 命中缓存绕过校验"的漏洞。
2. **`suggest-questions` 提示词的 JSON schema** 由任务说明给出的裸数组 `[{"question":...}]` 调整为
   `{"questions":[{"question":...}]}`。仓库现有的 `generateJson`/`parseJsonOutput`（`model/structured.ts`）
   统一按"取首个 `{` 到末个 `}`"解析对象，本仓库其余全部提示词（`element-extract`、`contradiction-extract`
   等）也都是对象包数组的形状；裸数组会被错误地拼接解析、多数情况下直接 JSON.parse 失败。改为对象包裹
   以复用现有共享解析器，不为这一条提示词另起一套数组解析逻辑。
3. **`PromptService.ManagedPromptId` 未包含任务说明中列出的 `generate-summary` / `generate-conclusion` /
   `extract-claims`**。这三个提示词 id 服务于报告自动草稿生成（路线图 Task 2.4，由另一 Agent 并行实施），
   本任务组（Task Group A）未使用、也未拿到其提示词正文，遵循 CLAUDE.md"最小实现"原则不臆造内容占位；
   `PromptService` 的 `ManagedPromptId` 直接复用 `prompt-store.ts` 的类型定义，Task 2.4 落地对应
   `REGISTERED_PROMPTS` 条目后会自动纳入，无需再改 `PromptService`。
4. **`SuggestionService` 构造函数新增 3 个必填参数**（`context: ContextService`、`prompts: PromptService`、
   `llm: LlmDeps`），而非把 LLM 相关依赖做成可选——与 `ElementService`/`ContradictionService` 等既有服务的
   `LlmDeps`（`adapter` 可为 `null`）用法保持一致，而不是让整个依赖可选，`app.ts` 与既有测试的构造调用点
   均已同步更新。

### 遗留观察项（非本阶段范围，供阶段 3 或后续迭代参考）

- LLM 生成问题的"相关性 > 70%"验收项需要人工评测真实生成结果，本阶段只做到"机制就绪 + 结构化输出 +
  降级保底"，未接入真实模型跑评测集。
- 前端"深度分析"作为建议模式切换按钮的文案，与既有问答框里"深度分析"复选框（`deepMode`，控制检索/读取
  预算而非建议来源）字面重复，两者语义不同但同屏可能引起混淆；因任务说明明确给出该文案，本阶段未改名，
  留待后续 UX 走查时统一措辞。
- `ContextService` 的缓存目前无显式失效入口（仅 30 秒 TTL 被动过期）：素材加工完成、要素重新抽取等事件
  发生后 30 秒内的问题推荐可能仍看到旧上下文。阶段 1 的建议接口本身也是"即时计算不缓存"，这里引入 30 秒
  窗口是新的权衡，若后续发现 30 秒内的陈旧数据造成困扰，可考虑在对应写操作后主动失效缓存键。

---

## 阶段 2 Task 2.4 实施说明（2026-07-03）：报告自动草稿——LLM 生成情况概要 / 分析结论

### 已交付

- **`prompt-store.ts`**：`REGISTERED_PROMPTS` 新增 `generate-summary`（情况概要，2-3 段）与
  `generate-conclusion`（分析结论，1-2 段）两条中文提示词，均以 `{findings}` 承接已核准 Finding 的结论
  文本列表；不新增任务说明未提及的 `extract-claims`（阶段 2 Task Group A 遗留观察项中明确留给 Task 2.4，
  但本次任务未收到该提示词的具体用途/正文，遵循 CLAUDE.md"最小实现"不臆造）。
- **`ReportService`**（`packages/server/src/report/report-service.ts`）：
  - 构造函数新增 3 个可选参数 `context?: ContextService`、`prompt?: PromptService`、`llm?: LlmDeps`
    （置于既有 4 个可选依赖之后，保持向后兼容——多处既有测试仍以 4 参数构造 `ReportService` 且未受影响）。
  - `generateAutoDraft` 的"情况概要"/"分析结论"两个占位分支替换为 `generateSummaryWithLLM` /
    `generateConclusionWithLLM`：均委托私有 `generateReportProse`（两者仅提示词 id / 审计动作名 /
    `maxTokens` 不同，抽公共实现避免重复）。
  - `generateReportProse`：`llm.adapter` 未配置或 `prompt` 未注入 → 直接返回
    `（{概要|结论}需手动编写：文本模型未配置）`，不触发任何 LLM 调用；已配置时用
    `PromptService.getPrompt` 渲染 `{findings}`（格式：`- {结论} (置信度: {百分比}%)`），
    `guardModelAdapter`（复用 `InquiryService`/`SuggestionService` 同款出站授权模式）包一层零外发闸门，
    `temperature: 0.3`、`thinking: { type: "disabled" }`（概要/结论是收敛性写作任务，不需要推理）。
  - 生成结果为空串 → 归一化为 `（LLM 生成失败，请手动编写{概要|结论}）`；调用抛错（超时/授权拒绝/网络
    错误）→ 捕获后返回 `（{概要|结论}生成失败，请手动编写）`，两种失败路径都不向上抛错，不阻断草稿生成。
  - 章节 `coverage_status`：LLM 成功生成记 `"covered"`；命中"手动编写"占位（未配置）记 `"uncovered"`；
    调用失败记 `"uncovered"`（判定依据是 body 是否包含"手动编写"字样，与未配置分支共用同一标记词，
    简化判断逻辑，无需额外状态字段）。
  - 审计：成功记 `report.llm.summary` / `report.llm.conclusion`（`detail.usage` 透传 token 用量，若适配器
    未返回 `usage` 则为 `undefined`）；失败记同名动作 + `result: "error"` + `detail.error`。
- **`app.ts`**：在 `reports` 装配前提前构造 `promptService` / `context`（原先这两者在 `reports` 之后才
  创建），并把三者一并注入 `ReportService`。
- **测试**（`packages/server/tests/report-auto-draft.test.ts`）：
  - 原有用例（模板驱动的时间线/发现/矛盾章节、审计、无 Finding 兜底）全部保留；"占位符"用例改名为
    "falls back to a friendly placeholder when the LLM is not configured"，断言从"包含待填写字样"改为
    精确匹配未配置提示文案。
  - 新增 `LLM-generated summary and conclusion` 描述块（4 个用例，脚本化 `ModelAdapter`，不出真实网络）：
    成功生成概要/结论并标记 `covered`、调用抛错时降级为占位文案并标记 `uncovered` + 记错误审计。
    复用 `suggestion-service.test.ts` 的 `chunkToCitation` + 真实素材摄入模式构造可通过引用完整性校验的
    已核准 Finding，而非直接手写 Citation 对象。
  - `packages/server/tests/prompt-store.test.ts` 的字节级默认提示词回归用例（`EXPECTED_DEFAULTS` /
    `promptIds()`）同步补入 `generate-summary` / `generate-conclusion`，否则会因新增的两条受管提示词
    而失败（该测试逐字节校验 `DEFAULT_PROMPT_BODIES`，属预期内的连带更新，非本次改动引入的回归）。
- `pnpm typecheck`（`server` 含 `tsconfig.eval.json`）与全量 `vitest run`（812 通过 / 3 跳过，跳过用例
  与阶段 1/2A 相同）均通过。

### 与原计划的偏差（及理由）

1. **未新增 `extract-claims` 提示词**：阶段 2 Task Group A 的遗留说明提到该 id "服务于报告自动草稿生成"，
   但任务说明本身（Task 2.4 工单）只要求概要与结论两条提示词，未给出 `extract-claims` 的用途或正文。
   按 CLAUDE.md"没有请求之外的功能"原则，本次不臆造第三条提示词；若后续报告草稿需要"声明核实"能力，
   应在收到明确需求时再补（`ContextService` 已预留 `verify-claims` 用途枚举，届时可直接复用）。
2. **`ReportService` 新依赖设为可选参数而非必填**：与 `SuggestionService`（`llm: LlmDeps` 必填、`adapter`
   内部可空）的既有模式不同，这里选择让 `context`/`prompt`/`llm` 整体可选。原因是 `ReportService` 已有
   4 个既存可选依赖（`findingService` 等，供 `generateAutoDraft` 用，`draft`/`submit`/`approve` 等核心
   报告状态机方法完全不需要它们），多处既有测试（`report.test.ts`、`export-gate-pool.test.ts`、
   `demo-seed.test.ts`、`permission-audit.test.ts`）只传 3 个参数构造 `ReportService`——沿用"可选、缺省
   退化"的既有约定而非改变构造契约，避免连带修改这些测试文件（超出本任务范围）。
3. **`coverage_status` 复用"手动编写"字样判断，未加显式状态字段**：任务说明给出的示例代码就是
   `summaryBody.includes('手动编写')`，两种"不可用"情形（未配置 / 调用失败）文案都包含该词，一次
   `includes` 判断即可覆盖，未引入额外的返回值结构（如 `{ body, covered }`）——符合"最小实现"，
   且失败文案与未配置文案本就该同等对待为"待人工介入"。

### 遗留观察项（非本阶段范围，供阶段 3 或后续迭代参考）

- LLM 生成概要/结论的"可用性 > 60%"验收项同样需要人工评测真实生成结果，本阶段只做到"机制就绪 + 降级
  保底"，未接入真实模型跑评测集（与阶段 2 Task Group A 的问题生成相关性验收项处境一致）。
- 前端尚未接入"自动生成草稿"按钮调用 `generateAutoDraft`（原路线图 Task 2.4 产出项之一）；后端能力已
  完整可用，接线为纯前端工作，未来可独立排期。
- `generateReportProse` 每次调用都重新渲染 `{findings}` 文本，未走 `ContextService` 的 `generate-report`
  用途缓存（`buildContext` 聚合的是素材/要素/矛盾/问答/Finding 摘要，与这里直接从 `approvedFindings` 拼
  结论文本是两条独立路径）；`ReportService` 构造函数已接入 `context` 参数但目前未使用，为后续如需引入
  更丰富的报告上下文（如素材摘录）预留了接口，暂不强行接入以免引入未被要求的复杂度。

---

## 参考资料

- [代码审查报告](../report/comprehensive-code-review-2026-07-03.md)（如果创建）
- [溯源问答架构文档](../architecture/inquiry-agent-harness.md)
- [矛盾检测决策](./inquiry-agent-harness-decision.md)

---

## 变更日志

| 日期 | 变更 | 原因 |
|------|------|------|
| 2026-07-03 | 初始版本，选择方案 A | 代码审查发现用户引导不足 |
| 2026-07-03 | 阶段 1 实施完成：`SuggestionService` + 建议路由 + 前端集成 + 测试 | 见"阶段 1 实施说明" |
| 2026-07-03 | 阶段 2 Task Group A 完成：`ContextService` + `PromptService` + LLM 增强问题生成 | 见"阶段 2 Task Group A 实施说明" |
| 2026-07-03 | 阶段 2 Task 2.4 完成：报告自动草稿——LLM 生成情况概要 / 分析结论 | 见"阶段 2 Task 2.4 实施说明" |
