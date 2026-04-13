# Mini Agent Runtime v1.1 Spec

- 项目代号：`mini-agent`
- 文档版本：`v1.1-draft`
- 状态：`Draft / 待进入实现`
- 前置版本：`working v1 baseline`
- 文档类型：`增量规格（delta spec）`
- 目标读者：Runtime 开发者、维护者、课程项目作者、Skill 作者

---

## 1. 文档目的

本文档定义 `mini-agent` 在 `working v1 baseline` 之后的下一个明确迭代：`v1.1`。

`v1.1` 的目标不是扩大功能面，而是在保留现有架构前提下，完成以下三类工作：

1. **Spec Hardening**：把已经在实现中修正过的关键规则正式写入规格。
2. **Operator Readiness**：让 provider/model 诊断、CLI 错误提示、doctor 检查更适合持续使用。
3. **Maintainer Readiness**：让后续开发者与 Skill 作者能理解和扩展系统，而不必只读源码。

因此，`v1.1` 是一次 **收口与加固迭代**，不是一次新功能扩张迭代。

---

## 2. 与 v1 的关系

### 2.1 v1 已有能力

`v1` 已具备：

- agent loop
- session store
- skill discovery / activation
- built-in tools：`read`、`write`、`edit`、`bash`、`activate_skill`
- OpenAI-compatible model adapter
- 基础 CLI 与 `doctor`

### 2.2 v1.1 的工作方式

`v1.1` 采用 **delta** 思路：

- 不重写 runtime 主体
- 不推翻现有 session / tool / skill 基线
- 只对规则、契约、诊断、文档和最小可运维性做增强

### 2.3 v1.1 不追求的事

`v1.1` 明确不追求：

- assistant token streaming
- provider fallback / model fallback 链
- richer session branching / tree replay
- subagents
- 新的大型 built-in tools 家族
- 远程执行器 / 沙箱 / MCP runtime
- 自动上下文压缩（compaction）

这些事项如需推进，应放入 `v1.2+` 讨论。

---

## 3. v1.1 设计目标

### 3.1 核心目标

`v1.1` 必须实现以下目标：

1. **Formal Session Grammar**：会话记录的合法顺序可被明确判断。
2. **Formal Tool Contract**：工具调用的行为边界和结果 envelope 被规范化。
3. **Visible Corruption Policy**：损坏 session 的检测、展示、恢复策略明确。
4. **Operator Diagnostics**：provider/model 错误对操作者更透明。
5. **Maintainer Docs**：核心实现机制形成可维护文档。
6. **Skill Authoring Readiness**：具备编写和测试真实 Skill 的最小文档与约束。

### 3.2 非目标

`v1.1` 不负责解决：

1. 跨 provider 的高可用路由
2. 真正意义上的 IDE 级体验
3. 多用户、多会话协同
4. 自动权限审批工作流
5. 高级调度与并行 agent orchestration

---

## 4. v1.1 范围

`v1.1` 包含五个工作域：

1. Session Grammar & Recovery
2. Tool Execution Contract
3. CLI / Doctor Operator Ergonomics
4. Maintainer Documentation
5. First-skill readiness（文档与夹具准备，不含完整业务 Skill 实现）

---

## 5. Session Grammar 规格

### 5.1 目标

为 session loader、session resume、session inspection、corruption handling 提供统一判定标准。

### 5.2 Session Entry 类型

`v1.1` 将 session entry 明确划分为以下类型：

- `session_header`
- `message`
- `tool_call`
- `tool_result`
- `skill_activation`
- `error`

### 5.3 Header 规则

必须满足：

1. 每个 session 文件必须且只能有一个 `session_header`。
2. `session_header` 必须是第一条 entry。
3. `session_header.id` 必须与外部 session id 一致。
4. 若 header 缺失、重复或 id 不匹配，则该 session 至少应被标记为 `corrupted`。

### 5.4 Turn 规则

`v1.1` 将一个 turn 定义为：

- 从一条 `message(role=user)` 开始
- 经过零次或多次 assistant → tool 循环
- 最终以一条 `message(role=assistant, final=true)` 或 `error` 结束

### 5.5 合法事件序列

一个合法 turn 应遵循下列模式之一：

#### 模式 A：直接回复

```text
message(user)
message(assistant, final=true)
```

#### 模式 B：单轮工具调用后回复

```text
message(user)
message(assistant, wants_tools=true)
tool_call+
tool_result+
message(assistant, final=true)
```

#### 模式 C：多轮工具调用后回复

```text
message(user)
[
  message(assistant, wants_tools=true)
  tool_call+
  tool_result+
]+
message(assistant, final=true)
```

#### 模式 D：以错误结束

```text
message(user)
...
error
```

### 5.6 Tool 相关约束

必须满足：

1. `tool_call` 只能出现在当前 turn 已开启的情况下。
2. 每条 `tool_call` 必须具有唯一 `call_id`。
3. 每条 `tool_result` 必须引用已存在且未闭合的 `tool_call.call_id`。
4. 未匹配的 `tool_call` 不得跨 turn 悬挂。
5. 在存在未匹配 `tool_call` 时，不得开始新的 `message(role=user)`。

### 5.7 Skill Activation 约束

必须满足：

1. `skill_activation` 只能在 `activate_skill` 成功完成后出现。
2. `skill_activation.name` 必须对应当前 registry 中可识别的 Skill。
3. session resume 时，历史 `skill_activation` 必须可重建到内存状态中。
4. 若 `skill_activation` 指向缺失 Skill，则 session 至少应被标记为 `degraded`。

### 5.8 Error 约束

必须满足：

1. runtime failure、tool failure、model failure 均应形成结构化 `error` entry。
2. `error` 终止当前 turn。
3. 对于 resume 场景，是否允许在 `error` 后继续新 turn，应由 loader 判定该 session 是否仍然有效。

推荐规则：

- 若 `error` 前的 turn 结构完整，则 session 可继续使用。
- 若 `error` 发生在未闭合 `tool_call` 状态下，则默认视为 corrupted 或 recoverable-corrupted。

### 5.9 Corruption / Recovery 模式

`v1.1` 定义两种加载模式：

#### Strict Mode

- 默认用于 `resume`
- 发现非法顺序、未匹配 `tool_result`、header 异常等问题时，拒绝恢复
- session 标记为 `corrupted`

#### Recover Mode

- 默认用于 `session show --recover` 或显式恢复路径
- 允许只加载最长合法前缀
- 非法尾部不进入运行时上下文
- 由系统报告：
  - 原 session id
  - 截断点
  - corruption reason

推荐实现：

- recover 后创建新 session，而不是覆盖原 session
- 原始损坏 session 保留只读

### 5.10 Session Loader 必须输出的状态

session loader 至少应输出以下之一：

- `valid`
- `degraded`
- `corrupted`

其中：

- `valid`：可正常显示、可正常 resume
- `degraded`：可显示、可有限恢复，但需要告警
- `corrupted`：默认不可 resume，只能诊断或 recover

---

## 6. Tool Execution Contract

### 6.1 目标

将工具执行从“工具自行决定行为”提升为“runtime 统一施加约束”。

### 6.2 统一输入校验

必须满足：

1. 所有 tool call 在执行前必须进行 schema 校验。
2. 校验失败不得进入工具实现。
3. 校验失败必须返回结构化错误，而不是抛出未捕获异常。

### 6.3 统一 timeout 规则

必须满足：

1. 每次 tool call 均受 runtime-level timeout 控制。
2. 工具可接受请求级 timeout，但不得超过 runtime config 上限。
3. timeout 必须形成结构化错误与相应事件记录。

### 6.4 Abort 规则

必须满足：

1. 若运行已被 abort，则新的 tool call 不得启动。
2. 运行中的工具必须接收 abort signal。
3. abort 必须以显式状态结束，而不是静默中断。

### 6.5 统一 Tool Result Envelope

`v1.1` 规定所有工具都必须返回统一 envelope：

```ts
type ToolResult = {
  ok: boolean
  content: string
  artifacts?: Array<{
    type: "log" | "file" | "json"
    path: string
    description?: string
  }>
  meta?: Record<string, unknown>
  error?: {
    code: string
    message: string
    retryable?: boolean
  }
}
```

约束：

1. 成功时 `ok=true`。
2. 失败时 `ok=false` 且必须包含 `error`。
3. 无论成功或失败，`content` 应为模型可理解的摘要文本。

### 6.6 工具事件要求

每个工具调用至少要有以下事件：

- `tool_execution_start`
- `tool_execution_end`

对具有持续输出的工具，可选支持：

- `tool_execution_update`

### 6.7 Path Policy

必须满足：

1. `read/write/edit` 默认仅允许访问 workspace root 内路径。
2. 所有路径必须先 canonicalize，再进行边界判断。
3. 必须阻止路径穿越与符号链接逃逸。
4. `bash` 的默认工作目录必须位于 workspace 内。

### 6.8 File Mutation Queue

必须满足：

1. 所有 `write/edit` 必须按绝对路径串行化。
2. 同一路径不得存在未受控并发写。
3. 串行化规则应由 runtime 实现，而不是由工具调用者保证。

### 6.9 Read Contract

必须满足：

1. bounded read 不得先整文件读入内存。
2. 对大文件读取应采用流式或分段读取。
3. 截断输出时必须保持 UTF-8 边界完整。

### 6.10 Bash Contract

必须满足：

1. bash 输出在执行期间可流式写入 artifact log。
2. 内存中仅保留有界 tail，用于返回给模型。
3. 完整日志应落盘并以 artifact 形式暴露。
4. per-call timeout 不得超过 runtime config 上限。
5. 超时、退出码异常、signal 终止必须结构化返回。

### 6.11 Edit Contract

必须满足：

1. edit 过程至少对以下内容做标准化处理：
   - BOM
   - CRLF/LF
   - smart quotes
   - dash 变体
   - 特殊空格
2. edit 失败时，应返回可诊断的未匹配信息，而不是模糊失败。

---

## 7. CLI / Doctor Operator Ergonomics

### 7.1 目标

提高模型/provider 问题、session 问题和环境问题的可诊断性。

### 7.2 `doctor` 最小增强要求

`doctor` 至少应输出以下分组结果：

1. runtime basics
   - cwd
   - session dir
   - skill dir
   - config source
2. model/provider config
   - provider
   - model
   - baseURL
   - apiKey presence
3. skill discovery
   - catalog size
   - duplicated names
   - parse failures
4. session health
   - recent corrupted sessions
   - recent degraded sessions
5. optional smoke path
   - known-good provider/model config 是否已设置

### 7.3 CLI 错误提示增强

CLI 应避免把 provider 侧问题压成单一消息。至少应区分：

- auth/config error
- quota/billing error
- unsupported model error
- upstream network error
- malformed response error
- runtime local validation error
- session corrupted error

### 7.4 错误代码建议

建议统一使用错误代码前缀：

- `MODEL_*`
- `TOOL_*`
- `SESSION_*`
- `SKILL_*`
- `CONFIG_*`

---

## 8. Maintainer Documentation

`v1.1` 必须新增或完善以下文档：

### 8.1 `docs/session-format.md`

至少说明：

- session entry 类型
- entry 字段示例
- 合法顺序
- corruption 行为
- resume / recover 行为

### 8.2 `docs/tool-contracts.md`

至少说明：

- 统一 result envelope
- timeout / abort
- artifact 规则
- path policy
- mutation queue

### 8.3 `docs/model-adapter.md`

至少说明：

- adapter interface
- tool call 映射约定
- error surfacing 规则
- signal 传播约定

### 8.4 `docs/write-a-skill.md`

至少说明：

- Skill 目录结构
- `SKILL.md` frontmatter 约定
- activation 行为
- progressive disclosure
- 如何为 Skill 准备测试夹具

---

## 9. First-skill Readiness

`v1.1` 不要求实现完整业务 Skill，但必须为其落地做好准备。

### 9.1 要求

必须完成：

1. 选定首个真实 Skill（推荐 `intel-bulletin`）。
2. 建立最小 Skill 目录与模板。
3. 准备样例输入与验收夹具。
4. 明确成功标准。

### 9.2 建议的成功标准

首个真实 Skill 的 readiness 至少应可验证：

- skill 可被 discover
- skill 可被 activate
- skill 可调用现有 built-in tools
- 运行产物可持久化
- session 可正常 replay / resume

---

## 10. 测试要求

### 10.1 必须新增或完善的测试

1. session grammar conformance tests
2. corrupted session strict/recover tests
3. unmatched tool_call / tool_result tests
4. skill activation replay tests
5. timeout / abort contract tests
6. path traversal rejection tests
7. mutation queue serialization tests
8. bash artifact tail vs full-log tests
9. doctor output snapshot or structured tests
10. known-good provider smoke test（可按条件执行）

### 10.2 回归原则

`v1.1` 的新增测试应优先覆盖：

- 上一轮 review 暴露的问题
- 容易静默损坏状态的路径
- 恢复路径
- 运维误判高发路径

---

## 11. 验收标准

`v1.1` 完成时，至少应满足：

1. session grammar 已在 spec 中明确写出。
2. tool execution contract 已在 spec 中明确写出。
3. loader 可区分 `valid / degraded / corrupted`。
4. CLI/doctor 对 provider/model 问题更透明。
5. maintainer docs 至少完成最小可用版本。
6. 已选定并准备首个真实 Skill 的目录、样例和验收方式。
7. 所有新增测试通过，且不破坏现有 working v1 baseline。

---

## 12. 延后到 v1.2+ 的事项

以下内容显式延后：

- assistant token streaming
- provider fallback / automatic retry policy
- richer branching session tree
- subagents
- 额外内置工具族
- 远程执行 / 沙箱 / 容器后端
- 权限交互 UI
- context compaction

---

## 13. 结论

`v1.1` 的本质不是把 `mini-agent` 变得更“重”，而是让它从一个 working v1 baseline 变成一个：

- 规则更清楚
- 故障更透明
- 文档更可维护
- 更适合承载真实 Skill

的稳定运行时。

如果 `v1.1` 能按本规格完成，那么后续接入首个真实业务 Skill 时，团队面对的主要问题将不再是“runtime 到底靠不靠谱”，而是“业务 Skill 本身如何设计与评测”。
