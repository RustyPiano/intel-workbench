# Agent 自主调查 Harness 设计方案

**日期**: 2026-07-03  
**状态**: 已分化（2026-07-07 核实，见下方状态更新）  
**适用范围**: 补充核验 Agent、候选结论生成、核验池、报告生成前置质量  

> **状态更新（2026-07-07）**：本方案提出的新增能力已分化为"已实现"与"未实现/被取代"两部分。全仓 grep 核实：`search_materials`（全案关键词搜索）、`expand_chunk`（片段前后展开）、`submit_finding`（结构化提交核验池候选）**已实现**，见 `packages/server/src/inquiry/intel-harness.ts`。而 `submit_case_brief`、"全案巡检"按钮、`cases/{caseId}/agent-briefs.jsonl`、`coverage_check` 工具**全仓零命中，未实现**——这部分设想的产品目标已被阶段三以不同机制承接：案卷综述由 M2 研判简报（`brief-service.ts`，服务端派生统计 + LLM 概览逐句引用校验，而非 agent 自主提交 narrative）承接；覆盖检查由 M4 报告覆盖率（`report/coverage.ts`，规则判定五节是否满足）承接。详见根 `AGENTS.md`「当前进度」与 `implementation-notes.md` 阶段三 M2/M4 记录。

---

## 背景

当前系统已经形成了外层核验闭环：

```text
素材汇入 -> 系统解析 -> 补充核验 -> 结论核验 -> 人工核准 -> 报告复核 -> 审计留痕
```

但最新浏览器端到端检查发现，报告内容质量不达标。系统能跑通流程，但实际生成的报告只抓住了 `USCG/DVIDS 外部演示素材` 和 `三号门登记缺口`，没有抓住案卷主线：

- 蓝海星号靠泊时间冲突；
- 三号门 OCR 四车与人工登记两车不一致；
- 苏E6V03 地磅净重变化 18.6 吨但登记为空车；
- LH-7712 夜间出现在东三泊位北侧；
- 现场照片显示封志缺失，与后续封志巡检记录冲突；
- 后续简报未解释关键矛盾。

根因不是报告模板，也不是模型“不会总结”，而是当前 harness 仍把 Agent 限制成“带引用的问答器”。它主要围绕用户问题检索和回答，没有足够好的全案浏览、证据组织和结构化提交能力。

---

## 核心决策

系统应采用：

```text
外层 Workflow 管状态
内层 Agent 管调查
Harness 管边界
```

含义：

- Workflow 只负责阶段、权限、核验池、人工核准、报告闸门、审计链。
- Agent 自主决定先看哪些材料、搜哪些关键词、展开哪些上下文、形成哪些候选结论。
- Harness 不规定固定流程，只提供受控能力边界：只能读当前专题、写入只能走结构化出口、引用必须校验、调用必须审计。

不要把 Agent 做成固定步骤 worker。

---

## 设计原则

### 1. 给能力，不给轨道

Agent 不应被规定为：

```text
先搜索 -> 再读 chunk -> 再回答 -> 再生成报告
```

它应拥有类似分析员的基础动作：

```text
列案卷 -> 全案搜索 -> 局部展开 -> 交叉比对 -> 形成结论 -> 提交结构化产物
```

### 2. 约束放在边界，不放在思考路径

应该限制：

- 只能访问当前专题；
- 不能任意读宿主机路径；
- 不能绕过引用校验；
- 不能直接写报告；
- 写入核验池必须结构化；
- 所有读写工具调用进入审计链。

不应该限制：

- 必须先读哪份材料；
- 必须用哪个关键词；
- 必须按固定阶段内置顺序查；
- 只能看检索 top-k；
- 只能回答用户问过的问题。

### 3. 报告继续保持保守

报告生成器仍然只使用已核准结论。

不要让报告页重新读全案并自由发挥。否则会绕过核验池和人工核准，破坏本项目最核心的可审计闭环。

---

## 当前 Harness 问题

当前 `createIntelTools` 已具备部分能力：

- `search_chunks`
- `list_materials`
- `read_material_window`
- `read_chunk`
- `cite`
- `finalize_answer`
- 可选多媒体工具：`transcribe`、`caption_frame`、`ocr_region`

但仍有几个关键缺口。

### 问题 1：缺少 rg 式全案检索

`search_chunks` 是相关性检索，适合问答，但不适合案卷核验。

分析主案时，Agent 需要做的是：

```text
全案找 LH-7712 出现在哪些材料
全案找 三号门 / OCR / 地磅 / 封志 / 苏E6V03
按材料定位证据分布
```

这不是 top-k 检索能稳定完成的。

### 问题 2：输出结构太窄

`finalize_answer` 当前只保存：

```ts
claims: { text: string; cite_ids: string[] }[]
```

这只能表达“回答中的若干结论”，不能表达完整调查产物：

- 案件主线；
- 关键矛盾；
- 支持证据；
- 相反证据；
- 风险等级；
- 待核查点；
- 可入核验池结论。

### 问题 3：候选结论过度依赖问答

`SuggestionService.suggestFindings` 主要从已有问答 claim、已处理矛盾、时间线锚点中生成候选。

如果用户问题偏了，候选结论也会偏；如果问答没有覆盖主案事实，报告也不会覆盖。

### 问题 4：引用过滤后语义可能变宽

当前为了修复无效引用，系统会过滤不支撑或失效引用。但如果原 claim 文本很宽，过滤后剩下的引用可能只支撑其中一部分。

结果就是：结论文本看起来完整，引用池只支撑局部。

---

## 新 Harness 能力

### 1. `search_materials`

提供类似 `rg` 的受控全案搜索。

```ts
interface SearchMaterialsInput {
  query: string;
  material_id?: string;
  max_matches?: number;
  context_lines?: number;
}

interface SearchMaterialsMatch {
  material_id: string;
  filename: string;
  modality: Modality;
  chunk_id: string;
  chunk_index: number;
  line?: number;
  before?: string;
  match: string;
  after?: string;
}
```

规则：

- 只搜索当前专题已加工文本和可读 chunk；
- 返回命中上下文，不返回整库全文；
- 命中的 chunk 自动加入 citation ledger，后续可以 `cite`；
- 支持中文、英文、数字混合关键词；
- 所有调用写审计。

典型用途：

```text
search_materials("LH-7712")
search_materials("苏E6V03")
search_materials("三号门 OCR")
search_materials("封志")
```

### 2. `expand_chunk`

从命中片段向前后展开。

```ts
interface ExpandChunkInput {
  chunk_id: string;
  before?: number;
  after?: number;
}
```

规则：

- 只能展开当前专题 chunk；
- 展开结果受读取预算限制；
- 展开的 chunk 加入 citation ledger。

用途：

- 避免 Agent 只看孤立命中句；
- 让 Agent 能读到相邻时间、上下文解释和备注。

### 3. `submit_finding`

让 Agent 直接提交结构化核验池候选，而不是只通过问答 claim 间接转入。

```ts
interface SubmitFindingInput {
  conclusion: string;
  supporting_cite_ids: string[];
  opposing_cite_ids?: string[];
  reasoning: string;
  confidence: number;
  severity?: "low" | "medium" | "high";
  open_questions?: string[];
  tags?: string[];
}
```

规则：

- 只生成 `draft` 状态的核验池条目；
- 人工核准前不能进报告；
- cite_id 必须来自 `cite`；
- 服务端复用 Finding 引用校验；
- `reasoning` 进入审计或 Finding 元数据，不直接进入报告。

### 4. `submit_case_brief`

用于一次调查任务输出多条候选结论和案卷覆盖情况。

```ts
interface SubmitCaseBriefInput {
  narrative: string;
  findings: SubmitFindingInput[];
  key_entities: string[];
  key_timeline: string[];
  unresolved_questions: string[];
  coverage: {
    materials_seen: string[];
    materials_with_hits: string[];
    searched_terms: string[];
  };
}
```

规则：

- `findings` 仍逐条进入核验池草稿；
- `coverage` 用于审计和 UI 展示，不作为报告事实；
- 允许 Agent 说明“哪些材料读过、哪些关键词搜过”。

### 5. `coverage_check`

给 Agent 一个轻量自检工具，避免报告候选漏掉主线。

```ts
interface CoverageCheckInput {
  finding_ids?: string[];
  searched_terms?: string[];
}

interface CoverageCheckResult {
  warnings: string[];
  uncovered_materials: string[];
  weak_findings: { finding_id: string; reason: string }[];
}
```

第一版可以规则化，不需要 LLM：

- 当前专题有材料但未被任何候选结论引用；
- 关键高频实体未出现在候选结论中；
- 某条结论文本包含多个实体，但引用只来自单一材料；
- 支持引用少于 2 条；
- 有 opposing citation 但未说明取舍。

---

## Agent 方法论 Prompt 调整

当前任务提示偏“回答用户问题”。应改成区分两类任务。

### 补充核验任务

用户问具体问题时：

```text
你是案卷核验 Agent。用户问题是调查目标，不是固定检索词。
你可以自由选择只读工具。
如问题涉及全案判断，先 list_materials，再 search_materials 搜关键对象，必要时 read_material_window / expand_chunk。
最终通过 finalize_answer 提交带引用答案。
```

### 全案调查任务

系统生成候选结论或报告前置核验时：

```text
你是案卷核验 Agent。目标是找出本专题最重要的可核验结论，而不是回答单个用户问题。
先盘点材料，再围绕高频实体、时间、车辆/箱号、地点、矛盾词进行多轮搜索。
必须提交 submit_case_brief。
每条 finding 都要有支持引用；存在冲突时同时提交 opposing citation。
不要为了填满结论而编造；证据不足写入 unresolved_questions。
```

---

## 产品流调整

### 1. 补充核验

保留问答入口，但文案改为：

```text
让 Agent 自主查案卷并回答一个具体核验问题。
```

增加一个按钮：

```text
全案巡检
```

点击后触发全案调查任务，不需要用户先提问。

### 2. 结论核验

`待入池候选` 来源增加：

- 补充核验问答；
- 全案巡检；
- 矛盾核验；
- 时间线 / 要素；
- 人工创建。

每条候选显示：

- 结论；
- 支持证据；
- 相反证据；
- Agent 搜过哪些关键词；
- 覆盖了哪些材料；
- 未解决问题。

### 3. 报告复核

报告页不做自由生成。

它只展示：

- 已核准结论；
- 覆盖检查结果；
- 是否存在未处理高危矛盾；
- 生成草稿按钮。

---

## 数据结构调整

### Finding 元数据

扩展 `Finding`：

```ts
interface Finding {
  source?: {
    type: "agent-brief" | "inquiry" | "suggestion" | "contradiction" | "timeline" | "manual";
    id?: string;
  };
  reasoning?: string;
  severity?: "low" | "medium" | "high";
  tags?: string[];
  coverage?: {
    searched_terms?: string[];
    materials_seen?: string[];
    materials_with_hits?: string[];
  };
}
```

第一版可只加 `source`、`reasoning`、`severity`，其余作为后续字段。

### CaseBrief 存储

新增：

```text
cases/{caseId}/agent-briefs.jsonl
```

每次全案巡检追加一条：

```ts
interface AgentCaseBrief {
  id: string;
  ts: string;
  user: string;
  narrative: string;
  finding_ids: string[];
  key_entities: string[];
  key_timeline: string[];
  unresolved_questions: string[];
  coverage: {
    materials_seen: string[];
    materials_with_hits: string[];
    searched_terms: string[];
  };
}
```

---

## 权限与安全边界

### 允许

- 当前专题内列材料；
- 当前专题内搜索已加工文本；
- 当前专题内读取材料窗口；
- 当前专题内引用原文；
- 向核验池提交草稿结论。

### 禁止

- 读取任意宿主机路径；
- 读取其他专题；
- 修改原始素材；
- 直接生成已核准结论；
- 直接写报告；
- 绕过 quote/hash 校验；
- 在无引用情况下提交可入报告结论。

### 审计

新增审计动作：

- `tool.search_materials`
- `tool.expand_chunk`
- `tool.submit_finding`
- `tool.submit_case_brief`
- `agent.case_brief.create`

审计 detail 至少包括：

- caseId；
- tool；
- 参数摘要；
- 返回数量；
- readBytes；
- runId/sessionId；
- created finding ids。

---

## 实施计划

### 阶段 1：补齐读案卷能力

目标：让 Agent 能像分析员一样盘点和搜索案卷。

改动：

- 在 `intel-harness.ts` 增加 `search_materials`；
- 增加 `expand_chunk`；
- 调整 inquiry methodology prompt；
- 增加工具调用审计测试；
- 用港口活动案卷做端到端验证。

验收：

- Agent 能搜索 `LH-7712` 并找到泊位计划、堆场记录、照片 OCR、仓储台账、后续简报；
- Agent 能搜索 `苏E6V03` 并找到地磅异常；
- Agent 能搜索 `三号门` 并找到门岗登记、OCR、堆场复核、SOP。

### 阶段 2：结构化提交候选结论

目标：Agent 不只回答问题，还能提交核验池候选。

改动：

- 增加 `submit_finding`；
- Finding 增加最小 source/reasoning/severity 元数据；
- UI 在结论核验页展示来源与推理摘要；
- 服务端复用现有 Finding 校验。

验收：

- Agent 能提交至少 3 条主案候选：
  - 靠泊时间冲突；
  - 三号门车辆登记/OCR 不一致；
  - LH-7712 夜间流转与封志冲突。
- 候选进入核验池后仍为待复核，不能直接进报告。

### 阶段 3：全案巡检

目标：不依赖用户先问对问题。

改动：

- 增加 `submit_case_brief`；
- 新增 `agent-briefs.jsonl`；
- 补充核验页增加 `全案巡检` 按钮；
- 结论核验页显示来自全案巡检的候选结论。

验收：

- 用户点击一次 `全案巡检`，系统能生成覆盖主案事实的候选结论；
- 候选显示覆盖关键词和材料；
- 报告仍只引用人工核准后的结论。

### 阶段 4：覆盖检查

目标：防止“流程跑通但结论偏题”。

改动：

- 增加 `coverage_check`；
- 报告页显示覆盖警告；
- 导出闸门可先只提示，不强制阻断。

验收：

- 如果已核准结论没有覆盖 LH-7712、三号门、地磅、封志等主线证据，报告页提示“已核准结论覆盖不足”；
- 用户可回到全案巡检或结论核验补充。

---

## 港口活动验收样例

全案巡检后，系统至少应给出以下候选结论。

### 候选 1：靠泊时间记录存在冲突

结论：

```text
港口值班简报称蓝海星号 22:30 已完成靠泊，但 AIS 与 VTS 记录显示 23:10-23:18 仍在外锚地，23:27-23:35 才进入靠泊过程，简报时间可信度不足。
```

支持证据：

- 港口值班简报；
- AIS 合成记录；
- VTS 通话摘录；
- 泊位作业计划。

### 候选 2：三号门车辆登记存在缺口

结论：

```text
三号门人工登记仅记录两辆货车，但 OCR 与堆场复核显示当晚共有四辆货车进入，其中两辆未在门岗登记表中出现，且未见补录审批。
```

支持证据：

- 三号门车辆进出记录；
- 门岗 OCR 异常清单；
- 堆场清点记录；
- 安保值守要求摘编。

### 候选 3：苏E6V03 存在异常载重变化

结论：

```text
苏E6V03 入场毛重 35.4 吨、出场 16.8 吨，净重变化 18.6 吨，但出场登记仍填写为空车，存在未登记装卸或转运风险。
```

支持证据：

- 地磅称重记录；
- OCR 异常清单；
- 司机聊天或调度电话。

### 候选 4：LH-7712 夜间流转与封志状态异常

结论：

```text
LH-7712 未列入 7 月 1 日夜间卸载清单，且无夜间查验或转运审批；但堆场记录和现场照片显示其 23:16-23:18 出现在东三泊位北侧，照片还显示封志缺失和箱门擦痕，与 00:20 封志完好巡检记录存在冲突。
```

支持证据：

- 泊位作业计划；
- 海关查验预约单；
- 堆场清点记录；
- 现场照片 OCR；
- 封志巡检记录；
- 后续情况简报。

---

## 非目标

- 不给 Agent shell 权限。
- 不允许读取任意本地路径。
- 不让 Agent 直接修改报告或自动核准结论。
- 不把全案巡检做成固定脚本规则。
- 不用报告生成器弥补上游结论质量。

---

## 最终判断

本次改造的目标不是“再自动化一点”，而是把 Agent 从问答器升级为受控自主调查员。

外层流程继续保证可复核、可审计；内层 harness 必须给 Agent 足够的读案卷和组织证据能力。这样才能在课程演示中体现真正的 Agent 能力，而不是固定 workflow 包装下的问答系统。
