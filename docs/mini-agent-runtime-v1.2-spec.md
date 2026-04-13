# Mini Agent Runtime v1.2 Spec
状态：Proposed / Ready for implementation  
版本：v1.2  
日期：2026-04-13  
基线：v1.1 Implemented Baseline  
主题：Observable Runtime（可观测性与用户体验）

---

## 1. 文档目的

本规格定义 mini-agent 在 **v1.2** 阶段的目标、范围、接口与验收标准。

v1.1 已完成以下基线能力：

- session 持久化、恢复与回放
- skill discovery / activation
- built-in tools：`read` / `write` / `edit` / `bash` / `activate_skill`
- OpenAI-compatible model adapter
- CLI 与 `doctor`
- maintainer references
- 首个真实 skill 的 readiness path（`intel-bulletin`）

因此，v1.2 **不再以扩充 runtime 基础能力为主目标**。  
v1.2 的主目标是把 runtime 从“能跑”提升到“**可见、可解释、可诊断、可演示**”。

---

## 2. 背景与设计判断

当前项目已经证明：

1. runtime 与 skill 可以解耦开发；
2. runtime 已足够承载一个最小但完整的 skill-native agent loop；
3. 下一阶段的主要瓶颈不是“还能不能做更多”，而是：
   - 用户看不见 agent 现在在做什么；
   - 不知道为什么调用某个工具或 skill；
   - 失败时定位成本高；
   - 演示和汇报时缺少清晰的运行轨迹。

因此 v1.2 的产品问题不是“再加什么能力”，而是回答 5 个用户问题：

1. 它现在在做什么？
2. 它为什么这样做？
3. 它调用了什么技能和工具？
4. 每一步产出了什么？
5. 如果失败，失败在哪一层？

---

## 3. v1.2 总目标

v1.2 的目标是交付一个 **Observable Runtime**，使 mini-agent 在本地 CLI 环境中具备以下能力：

- 以统一事件模型记录一次 run 的关键过程；
- 在执行时实时向用户展示简洁可读的 timeline；
- 在执行后可回放 run，查看 tool / skill / artifact / error 明细；
- 提供“安全的思考摘要”，而不是暴露原始 chain-of-thought；
- 为 operator / maintainer 提供结构化 trace 与最近一次运行诊断；
- 在保持 runtime 最小化的前提下，为后续 Web viewer、OTel、评测系统预留兼容出口。

---

## 4. 非目标（明确排除）

以下内容 **不属于 v1.2 主范围**：

1. 新的 built-in tool 家族
2. subagents / multi-agent orchestration
3. provider fallback chain / model fallback chain
4. assistant token 级逐 token 流式输出
5. richer session branching / tree replay
6. MCP runtime / remote executor / sandbox
7. 自动 compaction
8. 完整图形化前端重构

说明：

- v1.2 允许 **事件级实时输出**，但不要求 assistant token streaming。
- v1.2 可以为未来 Web UI 留出 trace 接口，但不要求在本迭代内做完整前端产品。

---

## 5. 术语定义

### 5.1 Session
跨多轮用户交互的长期会话，负责保存对话上下文、tool result、skill activation 等历史。

### 5.2 Run
一次明确的执行过程。通常对应一次用户 prompt 被 runtime 接收后，到产出最终回答或失败的全过程。  
一个 session 内可包含多个 run。

### 5.3 Trace
一次 run 的完整结构化执行轨迹，由顺序事件组成。

### 5.4 Timeline
给最终用户展示的、可读性优先的 run 执行视图。  
timeline 是 trace 的用户态表达，不等于完整原始 trace。

### 5.5 Planning Summary / Reasoning Summary
面向用户暴露的“安全思考摘要”。  
用于解释当前计划、关键决策和下一步动作。  
**不等于原始 chain-of-thought。**

### 5.6 Artifact
在 run 中生成的文件或日志，例如：

- bash 日志文件
- 最终报文
- 中间 markdown
- 渲染输出
- JSON 结果文件

### 5.7 Operator
运行 runtime、调试 provider、定位故障的操作者。

### 5.8 Maintainer
维护 runtime 核心代码、工具契约、session/trace 结构与 skill 接口的开发者。

---

## 6. 设计原则

### 6.1 可观测性优先于新能力
v1.2 的主要价值在于“看得见”和“查得清”，而不是继续扩 runtime 面积。

### 6.2 默认简洁，细节可展开
默认用户视图只展示必要信息；更详细的参数、stdout、metadata 只在 verbose/debug 视图展示。

### 6.3 不暴露原始私有推理
runtime 只展示 reasoning/planning summary；不得以任何方式默认持久化或显示原始隐藏推理。

### 6.4 事件为单一事实来源
CLI timeline、`run show`、`doctor --last-run`、未来 Web trace viewer，都必须基于统一的 run event schema。

### 6.5 与 session 解耦但可关联
run trace 不应污染 v1.1 已稳定的 session grammar；应通过 `run_id` / `session_id` 进行关联。

### 6.6 向后兼容
v1.1 session 必须继续可读。  
没有 trace 的旧 session 也应能被展示，只是可观测性信息较少。

---

## 7. 用户故事

### 7.1 最终用户
作为用户，我希望在 agent 运行时看到：

- 它是否已经开始工作；
- 当前正在处理哪一步；
- 是否激活了 skill；
- 是否调用了工具；
- 是否生成了结果文件；
- 如果失败，失败在哪一步。

### 7.2 Operator
作为 operator，我希望看到：

- provider / model / baseURL 是否正确；
- 最近一次 run 的失败分类；
- 是 provider 问题、skill 问题、tool 问题还是 session 问题；
- run 的关键统计信息（耗时、tool 数、skill 数、artifact 数）。

### 7.3 Maintainer
作为 maintainer，我希望：

- 所有关键行为都落成结构化事件；
- 可以从 trace 还原一次 run 的关键路径；
- 可以编写测试验证事件顺序与摘要质量；
- 后续可以把 trace 输出映射到 OTel / LangSmith / 自建 viewer。

---

## 8. 作用域概览

v1.2 包含 6 个工作域：

1. **Run Event Schema**
2. **Trace Store**
3. **CLI Live Timeline**
4. **Run / Session Trace Inspection**
5. **Reasoning & Planning Summary**
6. **Operator Diagnostics Integration**

---

## 9. 总体架构变化

v1.2 在 v1.1 基线之上新增以下组件：

### 9.1 Run Manager
负责为每次执行创建 `run_id`、管理 run 生命周期、发出起止事件、汇总统计。

### 9.2 Event Bus
统一接受 runtime、model adapter、skill registry、tool executor 产生的事件，并分发到：

- CLI renderer
- trace store
- diagnostics aggregator

### 9.3 Trace Store
按 run 存储结构化 trace，供后续 `run show`、`doctor --last-run`、未来 viewer 使用。

### 9.4 Timeline Renderer
将结构化事件转成终端中人类可读的 timeline。

### 9.5 Summary Emitter
生成“计划摘要 / 决策摘要 / 结果摘要”。  
来源可以是：
- 模型显式 reasoning summary（如果 adapter 支持）
- runtime 基于事件合成的安全摘要
- tool / skill 提供的摘要文本

### 9.6 Diagnostics Aggregator
对最近一次 run 进行归纳，输出：
- 运行状态
- 关键失败点
- provider / tool / skill / session 分类
- 产物和日志入口

---

## 10. 目录与存储布局

v1.2 不改变 v1.1 的 session 根结构，但新增 run trace 目录。

建议目录：

```text
.mini-agent/
  sessions/
    <session-id>.jsonl
  runs/
    <run-id>/
      meta.json
      trace.jsonl
      artifacts/
        ...
  diagnostics/
    last-run.json
```

### 10.1 `meta.json`
保存 run 摘要元数据，例如：

- `run_id`
- `session_id`
- `trace_id`
- `status`
- `started_at`
- `ended_at`
- `provider`
- `model`
- `tool_calls`
- `skill_activations`
- `artifact_count`
- `duration_ms`
- `first_error_code`（如有）

### 10.2 `trace.jsonl`
每行一个事件，按 `seq` 单调递增追加写入。

### 10.3 `artifacts/`
本 run 内产生的 bash logs、rendered output、JSON dumps 等文件。

---

## 11. 数据模型

## 11.1 Run 生命周期状态

```text
pending -> started -> planning -> executing -> finalizing -> completed
                                           \-> failed
                                           \-> cancelled
```

### 11.1.1 状态解释
- `pending`：run 已创建但尚未真正开始
- `started`：收到用户输入，建立上下文
- `planning`：模型或 runtime 正在生成安全的计划摘要/决策
- `executing`：发生 skill activation、tool call、artifact 生成等动作
- `finalizing`：生成最终回答、写入收尾信息
- `completed`：成功结束
- `failed`：错误结束
- `cancelled`：用户中断或 abort signal 导致结束

---

## 11.2 统一事件包络（Event Envelope）

所有 run 事件必须符合以下公共结构：

```ts
type RunEventEnvelope = {
  schema_version: "v1.2"
  event_id: string
  trace_id: string
  run_id: string
  session_id?: string
  seq: number
  ts: string
  type: string
  phase: "planning" | "skill" | "tool" | "model" | "artifact" | "finalize" | "error" | "system"
  level: "info" | "warn" | "error" | "debug"
  summary: string
  data?: Record<string, unknown>
}
```

### 11.2.1 约束
1. `seq` 必须在同一 run 内严格递增。
2. `summary` 必须是人类可读的单行摘要，默认不超过 120 个可显示字符。
3. `data` 中可包含详细内容，但必须经过 redaction。
4. `summary` 不得包含原始私有推理内容。
5. 所有用户可见 timeline 默认使用 `summary` 渲染，而不是直接渲染 `data`。

---

## 11.3 事件类型

### 11.3.1 核心用户态事件（必须实现）

#### `run_started`
表示一次 run 开始。

必需数据：
- `input_preview`
- `cwd`
- `max_turns`

#### `planning_summary`
表示本轮的安全思考摘要 / 计划摘要。

必需数据：
- `source`: `"model"` | `"runtime"`
- `kind`: `"plan"` | `"decision"` | `"progress"`
- `text`

#### `skill_activated`
表示某个 skill 已成功激活。

必需数据：
- `skill_name`
- `skill_dir`
- `resource_count`

#### `tool_started`
表示工具开始执行。

必需数据：
- `tool_name`
- `call_id`
- `args_preview`

#### `tool_progress`
表示工具执行过程中的进展事件。

说明：
- 主要用于 bash / 长任务
- 可选实现，但 `bash` 推荐实现

常见数据：
- `tool_name`
- `call_id`
- `stream`: `"stdout"` | `"stderr"` | `"status"`
- `chunk_preview`

#### `tool_completed`
表示工具调用完成。

必需数据：
- `tool_name`
- `call_id`
- `ok`
- `result_preview`
- `artifact_paths`（可为空）

#### `artifact_created`
表示某个 artifact 已生成或被记录。

必需数据：
- `artifact_type`
- `path`
- `description`

#### `assistant_completed`
表示最终用户可见输出已形成。

必需数据：
- `output_preview`
- `char_count`

#### `run_completed`
表示 run 成功结束。

必需数据：
- `duration_ms`
- `tool_calls`
- `skill_activations`
- `artifact_count`

#### `run_failed`
表示 run 失败结束。

必需数据：
- `error_code`
- `error_layer`
- `user_message`
- `debug_message`（verbose/debug only）

---

### 11.3.2 操作员/调试事件（建议实现）

#### `model_request_started`
#### `model_response_received`
#### `session_resumed`
#### `redaction_applied`
#### `trace_exported`

这些事件默认不在 compact timeline 中显示，但在 verbose 或 JSON trace 中可见。

---

## 12. 事件顺序规则

v1.2 为 run trace 定义最小合法顺序：

1. 每个 run 必须以 `run_started` 开始。
2. `run_completed` / `run_failed` / `run_cancelled` 三者必须且只能出现一个，并作为终止事件。
3. `tool_completed` 必须在同一 `call_id` 的 `tool_started` 之后。
4. `artifact_created` 可以发生在 `tool_completed` 前或后，但必须引用现有上下文。
5. `planning_summary` 可以出现多次，但第一次应不晚于：
   - 第一个 `tool_started`，或
   - 第一个 `assistant_completed`
6. 若发生 `skill_activated`，则必须在 `run_completed` 之前。
7. 若发生 `run_failed`，则该 event 必须包含归因层 `error_layer`。

### 12.1 容错
如果 trace 末尾因中断而不完整：

- `run show --recover` 可以展示最长有效前缀；
- 默认模式应提示该 run 为 `incomplete` 或 `degraded`；
- 不得把不完整 run 当作 `completed`。

---

## 13. Reasoning / Planning Summary 规范

## 13.1 目标
向用户展示“为什么这样做”，但不泄漏原始隐藏推理。

## 13.2 数据来源优先级

1. **模型提供的 reasoning summary**（若 adapter 显式支持）
2. **runtime 基于事件生成的 deterministic summary**
3. **skill/tool 自带的摘要文本**

## 13.3 展示规则

### 13.3.1 必须允许展示
- 当前计划
- 关键决策理由
- 当前进度
- 当前阻塞点

### 13.3.2 默认不得展示
- 原始 chain-of-thought
- 未经过滤的内部 reasoning tokens
- 包含 secrets 或敏感上下文的长段推理文本

## 13.4 摘要类型

### `plan`
例：
- “准备先扫描技能目录，再读取源文件，最后生成报文。”

### `decision`
例：
- “检测到任务属于报文整编，因此激活 `intel-bulletin`。”

### `progress`
例：
- “已完成 2/4 步，正在执行渲染脚本。”

## 13.5 配置项

建议配置：

- `MINI_AGENT_REASONING_SUMMARY=auto|off|required`
- 默认：`auto`

解释：
- `auto`：有模型 summary 就用，没有则 runtime 生成
- `off`：不显示 summary
- `required`：若无法生成 summary，则 run 记警告事件

---

## 14. CLI 交互规格

v1.2 的 UX 主战场是 CLI。

## 14.1 默认执行体验

命令：

```bash
mini-agent "整理并生成报文"
```

默认输出示意：

```text
[run] started
[plan] 准备检查可用技能，并为报文生成选择合适流程
[skill] activated intel-bulletin
[tool] read fixtures/intel-bulletin/source-note.md
[tool] bash python scripts/render_report.py
[artifact] artifacts/run-123/report.md
[result] 已生成报文
[run] completed in 2.4s
```

要求：

1. 默认输出为 **compact timeline**
2. 每条事件一行
3. 必须包含可读 summary
4. 错误时必须输出失败层与简短修复方向

---

## 14.2 新增 CLI 选项

### 14.2.1 执行期选项

```bash
mini-agent "<prompt>" --trace compact|verbose|json
mini-agent "<prompt>" --show-plan
mini-agent "<prompt>" --hide-debug
```

建议默认：
- `--trace compact`

### 14.2.2 run 查询命令

```bash
mini-agent run list
mini-agent run show <run-id>
mini-agent run show <run-id> --format timeline|json|jsonl|markdown
mini-agent run show <run-id> --verbose
mini-agent run show <run-id> --recover
```

### 14.2.3 session 扩展命令

```bash
mini-agent session show <session-id> --trace
mini-agent session show <session-id> --run <run-id>
```

### 14.2.4 doctor 扩展命令

```bash
mini-agent doctor --last-run
mini-agent doctor --run <run-id>
```

---

## 15. CLI 渲染模式

### 15.1 Compact（默认）
面向普通用户，显示：
- plan / decision / progress
- skill activation
- tool start / complete
- artifact
- result
- failure summary

### 15.2 Verbose
额外显示：
- `args_preview`
- `result_preview`
- provider/model
- stdout tail
- timing
- error debug message

### 15.3 JSON
直接输出结构化事件流，用于脚本或外部 viewer。

---

## 16. Trace Store 规格

## 16.1 写入策略
- append-only
- 每次事件发出后尽快落盘
- 失败时至少保证 `run_started` 与最终终止事件之间的已生成前缀可见

## 16.2 幂等与恢复
- 同一 `event_id` 不得重复写入
- 若进程异常退出，可通过最长有效前缀恢复展示
- `meta.json` 允许在 run 结束时补写聚合统计

## 16.3 与 session 的关联
session entry 可新增可选字段：

```ts
run_id?: string
```

约束：
- 不改动 v1.1 已合法 session 的可读性
- 新 trace 系统不得成为 session load 的硬依赖

---

## 17. 结果可见性

v1.2 必须把以下结果变成“用户看得见的东西”：

### 17.1 Skill 可见
用户应能知道：
- 调用了哪个 skill
- 为什么调它
- skill 目录在哪里（verbose/debug）
- skill 激活是否成功

### 17.2 Tool 可见
用户应能知道：
- 调用了哪个工具
- 目的是什么
- 是否成功
- 返回了什么类型的结果

### 17.3 Artifact 可见
用户应能知道：
- 生成了哪些文件
- 文件在哪里
- 哪个步骤生成了它

### 17.4 Error 可见
用户应能知道：
- 失败在哪一层
- 是否可重试
- 下一步应该先检查什么

---

## 18. Error 分类

v1.2 的 `run_failed` 必须包含 `error_layer` 与 `error_code`。

### 18.1 `error_layer`
枚举建议：

- `provider`
- `model_adapter`
- `session`
- `skill`
- `tool_validation`
- `tool_execution`
- `artifact`
- `runtime`
- `user_abort`

### 18.2 `error_code` 示例

- `provider_auth_error`
- `provider_quota_error`
- `provider_network_error`
- `unsupported_model`
- `session_corrupted`
- `skill_not_found`
- `tool_invalid_args`
- `tool_timeout`
- `tool_nonzero_exit`
- `artifact_missing`
- `run_aborted`

### 18.3 用户提示
每个失败必须至少提供：

- `user_message`：给普通用户看的提示
- `debug_message`：给开发者看的详细信息（verbose/debug only）

---

## 19. Secrets 与 Redaction

v1.2 引入可观测性后，必须同步提高信息安全要求。

### 19.1 必须默认隐藏
- API keys
- bearer tokens
- auth headers
- 常见 secret 环境变量值
- 可能包含凭证的长命令参数

### 19.2 可展示但需摘要
- 文件路径
- 命令名称
- 截断后的 stdout / stderr tail
- tool args preview

### 19.3 Redaction 事件
若发生脱敏，允许发出：

```text
redaction_applied
```

但默认不在 compact timeline 显示。

---

## 20. 兼容性要求

### 20.1 与 v1.1 session 兼容
- v1.1 的 session 文件必须继续可读
- 没有 run trace 的旧 session 仍能 `session show`
- `session show --trace` 在旧 session 上可退化为“无 trace 数据”

### 20.2 与 skill 解耦
v1.2 不改变现有 skill 包格式。  
skill 仍按现有 Agent Skills 兼容格式组织。  
v1.2 只增强“skill 何时被激活、为何被激活、结果如何可见”。

### 20.3 与未来 observability 后端兼容
内部 trace schema 需保留映射空间，建议字段中保留：
- `trace_id`
- `run_id`
- `event_id`
- `phase`
- `level`

以便后续导出到 OTel / LangSmith / 自建 trace viewer。

---

## 21. 参考 TypeScript 接口（规范性示意）

```ts
export type RunStatus =
  | "pending"
  | "started"
  | "planning"
  | "executing"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled"

export type RunEvent = {
  schema_version: "v1.2"
  event_id: string
  trace_id: string
  run_id: string
  session_id?: string
  seq: number
  ts: string
  type: string
  phase: "planning" | "skill" | "tool" | "model" | "artifact" | "finalize" | "error" | "system"
  level: "info" | "warn" | "error" | "debug"
  summary: string
  data?: Record<string, unknown>
}

export type RunMeta = {
  run_id: string
  trace_id: string
  session_id?: string
  status: RunStatus
  started_at: string
  ended_at?: string
  provider?: string
  model?: string
  duration_ms?: number
  tool_calls: number
  skill_activations: number
  artifact_count: number
  first_error_code?: string
}
```

---

## 22. 关键实现要求

## 22.1 Event Bus
必须做到：
- tool / skill / runtime / model adapter 都能发事件
- 事件分发不阻塞主 loop
- 即使 CLI renderer 失败，trace store 仍可写入

## 22.2 Timeline Renderer
必须做到：
- 使用 `summary` 作为默认渲染内容
- 不直接 dump 全量 `data`
- 支持 compact / verbose / json 三种模式

## 22.3 Trace Store
必须做到：
- append-only JSONL
- 事件顺序可恢复
- 在崩溃后可读取最长有效前缀

## 22.4 Diagnostics Aggregator
必须做到：
- 基于最近一次 run 输出摘要
- 汇总 provider/model/skill/tool/artifact/error 信息
- 与 `doctor --last-run` 打通

---

## 23. 测试要求

v1.2 必须新增以下测试类别。

## 23.1 单元测试
1. event envelope 校验
2. summary 长度与脱敏校验
3. timeline renderer 输出校验
4. trace writer append/recover 校验
5. error 分类映射校验

## 23.2 集成测试
1. 成功路径：有 skill、有 tool、有 artifact 的完整 run
2. tool failure 路径：`bash` 非零退出
3. provider failure 路径：quota / auth / unsupported model 映射
4. session resume + run trace 关联
5. 旧 v1.1 session 向后兼容展示
6. `session show --trace` 与 `run show` 一致性

## 23.3 手工 smoke
1. compact timeline 是否足够可读
2. verbose 模式是否信息过载
3. 错误提示是否能指导下一步排查
4. 最近一次 run 的 doctor 输出是否有用

---

## 24. 验收标准（Definition of Done）

满足以下条件时，v1.2 可判定完成：

### 24.1 功能完成
- 每次 run 都会生成 trace
- CLI 默认显示 compact timeline
- `run list` / `run show` 可用
- `session show --trace` 可用
- `doctor --last-run` 可用
- skill / tool / artifact / error 都可见
- reasoning summary 以安全方式显示

### 24.2 正确性完成
- 事件顺序合法
- tool start / complete 成对出现
- 终止事件唯一
- 不暴露 raw chain-of-thought
- redaction 默认生效
- v1.1 session 向后兼容

### 24.3 体验完成
- 用户能在默认 CLI 输出中理解当前进度
- 失败时能看到失败层和简明原因
- maintainer 能通过 run trace 快速复盘一次执行

---

## 25. 里程碑拆分建议

### Milestone 1：Event Schema & Trace Store
- 定义 `RunEvent`
- 落盘 `trace.jsonl`
- 生成 `meta.json`

### Milestone 2：Instrumentation
- runtime / tool / skill / model adapter 发事件
- 错误分类接入 trace

### Milestone 3：CLI Timeline
- compact 渲染
- verbose 渲染
- json 输出

### Milestone 4：Inspection & Diagnostics
- `run list`
- `run show`
- `session show --trace`
- `doctor --last-run`

### Milestone 5：Summary & Safety
- reasoning/planning summary
- redaction
- 测试与文档

---

## 26. 延后到 v1.3+ 的候选项

以下能力可在 v1.2 之后再评估：

1. assistant token streaming
2. richer progress bars / TUI
3. trace filtering / search
4. Web trace viewer
5. OpenTelemetry export
6. LangSmith exporter
7. provider fallback chain
8. subagent timeline
9. 复杂批处理 run dashboard

---

## 27. 对课程项目的价值

本规格的价值不在于“多做了一个日志系统”，而在于：

- 让 Agent 的行为从黑盒变成可解释流程；
- 让 Skill 的调用过程可演示、可汇报、可评测；
- 让 runtime 真正成为可承载多个业务 skill 的平台；
- 为后续的文档整编、音视频分析、对话分析等 skill 提供统一可观测底座。

这会直接提升项目在以下维度上的表现：

- 方案规范性
- Agent 设计完整性
- 应用可解释性
- 效果分析可复现性
- 汇报展示质量

---

## 28. 结论

v1.2 的核心不是增加更多 runtime 功能，而是把 mini-agent 变成一个：

- **能被看见**
- **能被解释**
- **能被诊断**
- **能被演示**
- **能承载真实 skill 的可观测 Agent Runtime**

这一定义应作为 v1.2 的唯一主线，直到：

- 统一事件模型落地；
- CLI timeline 可用；
- run/session trace 可回放；
- 安全的 reasoning summary 可见；
- 失败定位和 artifact 可见性可用；

之后再进入下一阶段的 runtime 能力扩展或 skill 产品化。
