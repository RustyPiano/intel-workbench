# Mini Agent Runtime Spec

- 项目代号：`mini-agent`
- 文档版本：`v0.1`
- 状态：`Draft / 可直接启动开发`
- 目标读者：项目开发者、课程答辩评审、后续 Skill 作者
- 技术建议：Node.js 20+、TypeScript 5.x、ESM

---

## 1. 文档目的

本文档定义一个 **最小但完整** 的 Agent Runtime 规格，用于本地运行、加载 Agent Skills、执行文件与终端工具，并支持后续扩展到多种业务 Skill。

本文档的目标不是设计一个完整产品，而是给出一份可直接参照开发的 **工程规格**，确保实现时边界清晰、接口稳定、可测试、可演进。

---

## 2. 设计目标

### 2.1 核心目标

本 Runtime 必须满足以下目标：

1. **最小实现**：只实现理解原理所需的最小组件，不引入重型 UI、复杂插件系统、云端服务依赖。
2. **Skill Native**：以 Skill 为一等公民，Runtime 围绕 Skill 发现、激活、执行而设计。
3. **本地优先**：支持本地文件读写、编辑、终端执行。
4. **模型无关**：通过统一的 Model Adapter 适配不同支持 tool calling 的模型。
5. **可追踪**：会话、工具调用、Skill 激活必须有结构化记录。
6. **可扩展**：为未来加入 MCP、Subagent、Compaction、权限提示留出扩展点。

### 2.2 非目标

以下内容 **不纳入 v0.1**：

1. Web UI / TUI
2. 多用户协作
3. 远程执行器 / SSH / Docker 沙箱
4. 自动上下文压缩（compaction）
5. Subagent 并行委派
6. 完整权限交互界面
7. 插件热重载
8. Skill Marketplace / 远程 Registry

---

## 3. 设计原则

1. **Deterministic Core**：核心循环尽量可预测；复杂性放到 Skill 内部。
2. **Thin Runtime**：Runtime 负责“发现、路由、执行、记录”，而不是承载复杂业务逻辑。
3. **Progressive Disclosure**：启动时只暴露 Skill 元数据；需要时再加载正文和资源。
4. **File-first**：所有配置、Skill、会话记录优先采用可读写文本文件。
5. **Failure Visible**：失败不得静默，必须显式返回错误对象和日志位置。
6. **Safe by Default**：默认只允许在工作区内读写；默认顺序执行写类工具。

---

## 4. 术语定义

### 4.1 Runtime

负责运行 Agent Loop、管理上下文、路由工具、激活 Skill、记录会话的执行内核。

### 4.2 Tool

原子能力单元，例如：
- `read`
- `write`
- `edit`
- `bash`
- `activate_skill`

### 4.3 Skill

一个以 `SKILL.md` 为入口的能力包，内部可包含说明、脚本、模板、参考资料、资源文件。

### 4.4 Session

一次连续的交互执行过程，包含用户消息、assistant 消息、tool call、tool result、skill activation 等记录。

### 4.5 Workspace Root

Runtime 执行时的工作区根目录。所有默认文件操作均以该目录为边界。

### 4.6 Model Adapter

对具体模型 SDK 的抽象层，向 Runtime 暴露统一的“带工具调用的生成”接口。

---

## 5. 对齐标准与参考实现

### 5.1 Skill 格式标准

Runtime 采用 `agentskills.io` 当前开放规范作为 Skill 基础格式：

- 一个 Skill 至少包含一个 `SKILL.md`
- `SKILL.md` 使用 YAML frontmatter + Markdown 正文
- 可包含 `scripts/`、`references/`、`assets/` 等目录
- 推荐采用 progressive disclosure：启动只加载 `name + description`，激活时再加载全文，资源按需读取

### 5.2 Runtime 参考思路

工程结构参考 `pi-mono` 的“底层 runtime + 上层 coding agent”分层思想，但本项目只保留最小 runtime 所需部分：

- Agent loop
- Tool registry
- Session store
- Skill discovery / activation
- 基础文件与终端工具

不复刻其完整 CLI/TUI/扩展生态。

---

## 6. 总体架构

```text
CLI / API Entrypoint
        │
        ▼
Runtime Orchestrator
        │
 ┌──────┼───────────────┬───────────────┬───────────────┐
 ▼      ▼               ▼               ▼               ▼
Prompt  Model Adapter   Tool Registry   Skill Registry  Session Store
Build   (LLM API)       + Executor      + Catalog       + Logger
        │               │               │               │
        └───────────────┴───────┬───────┴───────────────┘
                                ▼
                           Policy Layer
                    (Path guard / timeout / queue)
```

### 6.1 模块职责

#### A. CLI / API Entrypoint

负责：
- 读取启动参数
- 解析 cwd / model / session / skill-dir
- 发起一次 prompt 或进入交互模式

#### B. Runtime Orchestrator

负责：
- 维护 Agent 状态
- 拼装 prompt 上下文
- 调用 Model Adapter
- 执行工具循环
- 处理停止条件

#### C. Tool Registry + Executor

负责：
- 注册工具 schema
- 执行工具调用
- 做参数校验
- 处理工具超时与错误
- 返回工具结果

#### D. Skill Registry

负责：
- 扫描 Skill 目录
- 解析 `SKILL.md`
- 构建 catalog
- 激活指定 Skill

#### E. Session Store

负责：
- 保存 JSONL 会话
- 恢复既有会话
- 记录消息、工具调用、技能激活、错误

#### F. Policy Layer

负责：
- 路径权限判断
- 写操作串行化
- bash 输出截断
- 路径归一化
- 恢复一致性检查

---

## 7. 范围与功能需求

### 7.1 必须实现的功能（MVP）

#### FR-001 启动 Runtime

系统必须支持以下启动方式：

1. 单轮模式：
   ```bash
   mini-agent "帮我整理当前项目结构"
   ```
2. 交互模式：
   ```bash
   mini-agent
   ```
3. 指定工作目录：
   ```bash
   mini-agent --cwd /path/to/project
   ```
4. 指定模型：
   ```bash
   mini-agent --model gpt-4.1
   ```
5. 指定额外 Skill 目录：
   ```bash
   mini-agent --skill-dir /path/to/skills
   ```

#### FR-002 Skill 发现

系统必须能够在以下位置发现 Skill：

1. `<workspace>/.agents/skills/`
2. 通过 `--skill-dir` 显式指定的目录
3. （可选）`~/.agents/skills/`

#### FR-003 Skill Catalog 暴露

系统启动时必须将所有 Skill 的最小元数据暴露给模型：

- `name`
- `description`
- `compatibility`（若存在）
- `allowed-tools`（若存在）

#### FR-004 Skill 激活

系统必须提供 `activate_skill` 工具，使模型或用户能够显式激活某个 Skill。

#### FR-005 文件操作

系统必须支持：

- `read`
- `write`
- `edit`

#### FR-006 终端执行

系统必须支持 `bash` 工具，能够：

- 在工作区内执行命令
- 流式获取 stdout/stderr
- 超时终止
- 结果落盘

#### FR-007 会话持久化

系统必须记录：

- 用户消息
- assistant 消息
- tool call
- tool result
- skill activation
- system error

#### FR-008 错误可见性

任何工具失败必须返回结构化错误，而不能只在 stdout 打印。

### 7.2 推荐实现的功能（v0.2）

1. 恢复已有 session
2. slash commands
3. AGENTS.md 上下文注入
4. read-only 模式
5. JSON 事件流模式
6. MCP adapter

---

## 8. 非功能需求

### NFR-001 可读性

代码结构必须适合课程展示和后续二开，避免过度抽象。

### NFR-002 可测试性

每个 Tool、Skill Registry、Session Store、Model Adapter 都应可单元测试。

### NFR-003 可替换性

模型适配器必须可替换，不得将 OpenAI/Anthropic SDK 逻辑写死在 Runtime Core 内。

### NFR-004 可观测性

所有关键步骤必须通过 Event Bus 产生结构化事件。

### NFR-005 安全默认值

默认限制写路径、限制工作目录、限制 Bash 超时、限制输出长度。

---

## 9. 目录结构规格

推荐仓库目录：

```text
mini-agent/
  src/
    cli/
      main.ts
      repl.ts
    runtime/
      agent.ts
      loop.ts
      prompt.ts
      events.ts
      session.ts
      policy.ts
      errors.ts
      types.ts
    tools/
      index.ts
      types.ts
      read.ts
      write.ts
      edit.ts
      bash.ts
      activate-skill.ts
      file-mutation-queue.ts
      utils/
        paths.ts
        text-normalize.ts
    skills/
      discover.ts
      parse-skill.ts
      registry.ts
      catalog.ts
      types.ts
    model/
      types.ts
      openai.ts
      anthropic.ts
      mock.ts
    utils/
      jsonl.ts
      fs.ts
      ids.ts
      logger.ts
  .agents/
    skills/
      example-skill/
        SKILL.md
        scripts/
        references/
        assets/
  sessions/
  tests/
  package.json
  tsconfig.json
  README.md
```

---

## 10. 核心运行流程

### 10.1 Agent Loop 状态机

```text
IDLE
  ↓ prompt(input)
PREPARE_CONTEXT
  ↓
MODEL_CALL
  ↓
ASSISTANT_MESSAGE_RECEIVED
  ├─ no tool call ──▶ COMPLETE
  └─ has tool call ─▶ EXECUTE_TOOLS
                         ↓
                    APPEND_TOOL_RESULTS
                         ↓
                    NEXT_MODEL_CALL
                         ↓
                       COMPLETE
```

### 10.2 单轮执行伪代码

```ts
async function run(prompt: string) {
  appendUserMessage(prompt)

  while (true) {
    const context = await buildContext()
    const assistant = await model.generate(context, tools)
    appendAssistantMessage(assistant)

    if (!assistant.toolCalls?.length) break

    for (const toolCall of assistant.toolCalls) {
      const result = await executeTool(toolCall)
      appendToolResult(toolCall, result)
    }
  }
}
```

### 10.3 停止条件

以下任一条件满足即结束本轮：

1. assistant 未产生 tool call
2. assistant 明确输出最终结果
3. 达到 `maxTurns`
4. 用户中断
5. 发生不可恢复错误

### 10.4 运行约束

默认建议：

- `maxTurns = 12`
- `toolTimeoutMs = 60_000`
- `bashTimeoutMs = 120_000`
- `maxBashOutputBytes = 64 * 1024`
- `maxReadBytes = 256 * 1024`

---

## 11. Prompt 组装规格

### 11.1 System Prompt 组成

System Prompt 由以下部分组成：

1. Runtime 基础行为规则
2. 工具使用规则
3. 当前工作区说明
4. Skill catalog
5. （可选）AGENTS.md 内容摘要
6. （可选）当前已激活 Skill 内容

### 11.2 Runtime 基础行为规则

必须至少包含：

1. 先规划，再执行
2. 需要文件内容时先 `read`
3. 修改文件前必须确认目标路径
4. 需要 Skill 时优先 `activate_skill`
5. 不得捏造工具结果
6. 对失败必须解释原因并给出下一步

### 11.3 Skill Catalog 注入格式

建议采用结构化文本而不是自由描述：

```xml
<available_skills>
  <skill>
    <name>intel-bulletin</name>
    <description>将多个文档整编为符合模板的正式报文。适用于文档汇总、情报整编、公文输出。</description>
    <compatibility>Requires Python 3.11+, pandoc</compatibility>
    <allowed_tools>read write edit bash</allowed_tools>
  </skill>
</available_skills>
```

---

## 12. Model Adapter 规格

### 12.1 目标

向 Runtime 提供统一接口，隐藏不同模型 SDK 差异。

### 12.2 接口定义

```ts
export interface ModelAdapter {
  name: string
  generate(input: GenerateInput): Promise<GenerateResult>
  stream?(input: GenerateInput): AsyncIterable<GenerateEvent>
}

export interface GenerateInput {
  systemPrompt: string
  messages: RuntimeMessage[]
  tools: ToolSpec[]
  signal?: AbortSignal
  temperature?: number
  maxTokens?: number
}

export interface GenerateResult {
  message: AssistantMessage
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "error"
  usage?: {
    inputTokens?: number
    outputTokens?: number
  }
}
```

### 12.3 适配器要求

1. 必须支持 tool calling
2. 必须返回结构化 tool call
3. 应支持流式输出
4. 应支持中断
5. 应保留 provider 原始响应以便调试

### 12.4 MVP 建议

- `openai.ts`
- `mock.ts`

先实现一个真实模型适配器和一个测试适配器即可。

---

## 13. Tool 系统规格

### 13.1 统一接口

```ts
export interface RuntimeTool<TArgs = unknown, TResult = unknown> {
  name: string
  description: string
  inputSchema: JsonSchema
  execute(args: TArgs, ctx: ToolContext): Promise<ToolExecutionResult<TResult>>
}

export interface ToolContext {
  workspaceRoot: string
  sessionId: string
  signal: AbortSignal
  logger: Logger
  skillRegistry: SkillRegistry
  policy: PolicyEngine
}

export interface ToolExecutionResult<T = unknown> {
  ok: boolean
  content: string
  data?: T
  error?: RuntimeErrorShape
  artifacts?: ToolArtifact[]
}
```

### 13.2 内置工具列表

#### 13.2.1 `read`

**用途**：读取文件内容。

**输入**：
```json
{
  "path": "src/index.ts",
  "offset": 1,
  "limit": 2000
}
```

**行为**：
- 路径相对 `workspaceRoot` 解析
- 检查路径权限
- 读取 UTF-8 文本文件
- `offset`/`limit` 以**行**为单位（`offset` 从 1 开始，`limit` 缺省 2000 行）
- 每行以行号加制表符前缀输出（`<n>\t`，即 cat -n 风格）；行号前缀不属于文件内容，复用为 edit old_text 前需去除
- `readMaxBytes` 限制单次扫描的字节数，过长的单行也会被截断
- 内容被截断时在元信息中标注 `truncated`

**输出**：
```json
{
  "ok": true,
  "content": "     1\t...第一行...\n     2\t...第二行...",
  "data": {
    "path": "/abs/path/src/index.ts",
    "offset": 1,
    "limit": 2000,
    "lines": 2,
    "truncated": false,
    "size": 1542
  }
}
```

#### 13.2.2 `write`

**用途**：写入整个文件。

**输入**：
```json
{
  "path": "notes/summary.md",
  "content": "# Summary\n...",
  "create_dirs": true,
  "overwrite": true
}
```

**行为**：
- 串行进入文件写队列
- 检查路径权限
- 必要时创建目录
- 原子写入：先写临时文件，再 rename

#### 13.2.3 `edit`

**用途**：基于 `old_text -> new_text` 的局部编辑。

**输入**：
```json
{
  "path": "README.md",
  "old_text": "TODO",
  "new_text": "DONE",
  "replace_all": false
}
```

**行为**：
- 统一行尾
- 去 BOM
- 对 smart quotes / em dash / 特殊空格进行归一化匹配
- 若 `old_text` 未匹配，返回结构化错误
- 若匹配多处但 `replace_all=false`，返回歧义错误

#### 13.2.4 `bash`

**用途**：在工作区执行 shell 命令。

**输入**：
```json
{
  "command": "npm test",
  "cwd": ".",
  "timeout_ms": 120000
}
```

**行为**：
- 使用系统 shell 执行
- 流式收集 stdout/stderr
- 达到上限时截断上下文输出
- 完整输出写入日志文件
- 超时杀进程
- 返回 exitCode

**输出**：
```json
{
  "ok": true,
  "content": "tests passed",
  "data": {
    "exitCode": 0,
    "stdoutTail": "...",
    "stderrTail": "",
    "logPath": ".mini-agent/artifacts/bash/<id>.log"
  }
}
```

#### 13.2.5 `activate_skill`

**用途**：加载一个 Skill 的完整正文和资源清单。

**输入**：
```json
{
  "name": "intel-bulletin"
}
```

**行为**：
- 通过 Skill Registry 查找 Skill
- 返回 Skill body
- 返回 skill 目录绝对路径
- 返回 references/scripts/assets 列表
- 可附带 compatibility 与 allowed-tools
- 已激活 Skill 应缓存并去重

**返回内容建议采用结构化包裹**：

```xml
<skill_content name="intel-bulletin">
# ...SKILL body...

Skill directory: /abs/path/.agents/skills/intel-bulletin
Compatibility: Requires Python 3.11+
Allowed tools: read write edit bash
<skill_resources>
  <file>scripts/render_docx.py</file>
  <file>references/format-guide.md</file>
  <file>assets/template.docx</file>
</skill_resources>
</skill_content>
```

---

## 14. Skill 系统规格

### 14.1 Skill 目录要求

每个 Skill 目录至少包含：

```text
skill-name/
  SKILL.md
```

可选：

```text
skill-name/
  SKILL.md
  scripts/
  references/
  assets/
```

### 14.2 `SKILL.md` 解析要求

必须支持：

- YAML frontmatter
- Markdown body

必须校验：

- `name`
- `description`

可解析：

- `license`
- `compatibility`
- `metadata`
- `allowed-tools`

### 14.3 Skill 元数据结构

```ts
export interface SkillMeta {
  name: string
  description: string
  license?: string
  compatibility?: string
  metadata?: Record<string, unknown>
  allowedTools?: string[]
  rootDir: string
  skillFile: string
}

export interface SkillRecord {
  meta: SkillMeta
  body: string
  resources: {
    scripts: string[]
    references: string[]
    assets: string[]
  }
}
```

### 14.4 Discovery 规则

按以下顺序加载：

1. CLI `--skill-dir`
2. `<workspace>/.agents/skills`
3. （可选）`~/.agents/skills`

冲突处理：

- 同名 Skill 以“离 workspace 最近”的定义优先
- 若冲突来自多个显式 `--skill-dir`，以后声明者覆盖前者
- 记录 warning

### 14.5 Skill 缓存

Runtime 内存中维护：

```ts
interface ActiveSkillState {
  activatedAt: string
  activationCount: number
  contentHash: string
}
```

规则：

- 已激活的 Skill 不重复插入全文
- 若被再次激活，仅在 session 中记录一次 activation event
- 后续 buildContext 时只保留一份 Skill 内容

### 14.6 Skill 资源读取约定

Skill 可引用以下资源：

- `scripts/*.py`
- `scripts/*.sh`
- `references/*.md`
- `assets/*`

Resource 路径必须：

1. 相对 Skill 根目录
2. 不允许越界到 Skill 根外
3. 建议一层引用，不做深层链式引用

---

## 15. Session 设计

### 15.1 目标

实现一个 **线性 JSONL 会话格式**，足够支撑：

- 调试
- 回放
- 错误恢复
- 课程展示

### 15.2 文件位置

建议：

```text
<workspace>/.mini-agent/sessions/<timestamp>_<uuid>.jsonl
```

### 15.3 Session Header

第一行必须是 header：

```json
{
  "type": "session_header",
  "version": 1,
  "sessionId": "sess_123",
  "createdAt": "2026-04-13T10:00:00Z",
  "workspaceRoot": "/abs/path/project",
  "model": "gpt-4.1",
  "runtimeVersion": "0.1.0"
}
```

### 15.4 Entry Types

必须支持：

1. `message`
2. `tool_call`
3. `tool_result`
4. `skill_activation`
5. `error`
6. `event`

#### `message`
```json
{
  "type": "message",
  "role": "user",
  "messageId": "msg_1",
  "timestamp": "...",
  "content": "帮我分析这个项目"
}
```

#### `tool_call`
```json
{
  "type": "tool_call",
  "toolCallId": "call_1",
  "toolName": "read",
  "args": {"path": "README.md"},
  "timestamp": "..."
}
```

#### `tool_result`
```json
{
  "type": "tool_result",
  "toolCallId": "call_1",
  "ok": true,
  "content": "...",
  "timestamp": "..."
}
```

#### `skill_activation`
```json
{
  "type": "skill_activation",
  "skill": "intel-bulletin",
  "contentHash": "sha256:...",
  "timestamp": "..."
}
```

### 15.5 一致性规则

加载 session 时必须检查：

1. `tool_result` 是否存在对应 `tool_call`
2. 事件顺序是否合法
3. header 是否完整
4. JSON 行是否可解析

若失败：

- 标记 session 为 `corrupted`
- 尽可能恢复可读部分
- 输出 repair report

---

## 16. Event Bus 规格

### 16.1 事件类型

必须支持以下内部事件：

- `agent_start`
- `turn_start`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `skill_activation`
- `turn_end`
- `agent_end`
- `runtime_error`

### 16.2 事件用途

1. CLI 实时输出
2. JSON mode 输出
3. 日志记录
4. 测试断言
5. 后续 UI 集成

### 16.3 Event Shape

```ts
type RuntimeEvent =
  | { type: "agent_start"; sessionId: string }
  | { type: "turn_start"; turn: number }
  | { type: "message_start"; role: "user" | "assistant" }
  | { type: "message_update"; delta: string }
  | { type: "message_end"; messageId: string }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string }
  | { type: "tool_execution_update"; toolCallId: string; partial: string }
  | { type: "tool_execution_end"; toolCallId: string; ok: boolean }
  | { type: "skill_activation"; name: string }
  | { type: "turn_end"; turn: number }
  | { type: "agent_end"; sessionId: string }
  | { type: "runtime_error"; error: RuntimeErrorShape }
```

---

## 17. Policy / Guardrails 规格

### 17.1 路径安全

#### 默认允许范围

- `workspaceRoot/**`
- 已发现的 Skill 根目录及其子路径

#### 默认拒绝范围

- `workspaceRoot` 外任意路径
- `~/.ssh/**`
- `/etc/**`
- 系统敏感目录

可通过 config 覆盖，但默认必须安全。

### 17.2 写操作队列

对于同一路径上的 `write` / `edit`：

- 必须串行化
- 通过 `Map<absolutePath, Promise>` 或 mutex 实现
- 防止并发覆盖

### 17.3 Bash 策略

默认：

- 仅在 `workspaceRoot` 内执行
- 默认超时 120s
- 默认最大上下文输出 64KB
- 全量输出落到 artifact 日志文件
- 返回日志路径

### 17.4 编辑鲁棒性

`edit` 执行前必须做：

1. 路径归一化
2. 文本编码检查
3. BOM 清除
4. CRLF/LF 归一化
5. Unicode 引号与 dash 归一化

### 17.5 Skill 信任模型

v0.1 采用简化策略：

- 项目内 `.agents/skills/` 默认信任
- `--skill-dir` 外部目录在启动时打印 warning
- 不做交互式确认

v0.2 可升级为显式 trust store。

---

## 18. 错误模型

### 18.1 错误分类

```ts
type RuntimeErrorCode =
  | "INVALID_ARGS"
  | "PATH_NOT_ALLOWED"
  | "FILE_NOT_FOUND"
  | "EDIT_NO_MATCH"
  | "EDIT_AMBIGUOUS"
  | "TOOL_TIMEOUT"
  | "PROCESS_EXIT_NONZERO"
  | "MODEL_ERROR"
  | "SESSION_CORRUPTED"
  | "SKILL_NOT_FOUND"
  | "SKILL_INVALID"
  | "INTERNAL_ERROR"
```

### 18.2 错误结构

```ts
interface RuntimeErrorShape {
  code: RuntimeErrorCode
  message: string
  retriable?: boolean
  details?: Record<string, unknown>
}
```

### 18.3 处理规则

1. Tool 级错误返回给模型
2. Runtime 级错误终止当前轮
3. Session 级错误允许进入只读恢复模式

---

## 19. 配置系统

### 19.1 配置来源优先级

1. CLI 参数
2. 环境变量
3. `mini-agent.config.json`
4. 默认值

### 19.2 配置结构

```json
{
  "model": "gpt-4.1",
  "workspaceRoot": ".",
  "sessionDir": ".mini-agent/sessions",
  "maxTurns": 12,
  "toolTimeoutMs": 60000,
  "bashTimeoutMs": 120000,
  "maxBashOutputBytes": 65536,
  "readMaxBytes": 262144,
  "globalSkillDirs": ["~/.agents/skills"],
  "allowReadOutsideWorkspace": false,
  "allowWriteOutsideWorkspace": false,
  "jsonEventMode": false
}
```

---

## 20. CLI 规格

### 20.1 命令行接口

```bash
mini-agent [prompt]
  --cwd <path>
  --model <name>
  --session <id>
  --skill-dir <path>    # repeatable
  --json-events
  --read-only
  --max-turns <n>
  --help
```

### 20.2 MVP 子命令（可选）

```bash
mini-agent skills list
mini-agent session list
mini-agent session show <id>
mini-agent doctor
```

其中 `skills list` 很适合课程展示。

---

## 21. 日志与产物

### 21.1 日志目录

```text
<workspace>/.mini-agent/
  sessions/
  logs/
  artifacts/
    bash/
    reports/
```

### 21.2 Bash Artifact

每次 bash 执行产生：

```text
.mini-agent/artifacts/bash/<toolCallId>.log
```

### 21.3 错误日志

严重错误写入：

```text
.mini-agent/logs/runtime-error.log
```

---

## 22. 测试规格

### 22.1 单元测试

至少覆盖：

1. `parse-skill`
2. `discover`
3. `read`
4. `write`
5. `edit`
6. `bash`
7. `session load/save`
8. `path policy`

### 22.2 集成测试

必须至少有以下场景：

1. 模型请求 `read -> edit -> write`
2. 激活 Skill 后执行 `bash scripts/*.py`
3. Bash 超时
4. Edit 无匹配
5. Skill 冲突覆盖
6. Session 损坏恢复

### 22.3 Mock Model 测试

实现一个 `mock.ts` 适配器，用预定义 tool call 序列验证 Runtime Loop。

---

## 23. 开发阶段规划

### Phase 0：项目脚手架

交付物：
- TypeScript 项目初始化
- 目录结构
- 基础类型与错误定义

### Phase 1：最小 Loop

交付物：
- Runtime loop
- mock model adapter
- session header + message 保存

### Phase 2：基础工具

交付物：
- read / write / edit / bash
- 文件写队列
- bash 日志落盘

### Phase 3：Skill 支持

交付物：
- Skill discovery
- frontmatter 解析
- activate_skill
- catalog 注入

### Phase 4：CLI 与恢复

交付物：
- 交互模式
- JSON event mode
- resume/load session

### Phase 5：业务 Skill 接入

交付物：
- `intel-bulletin`
- `meeting-scene-analysis`

---

## 24. 验收标准

系统在满足以下条件时视为 v0.1 可验收：

1. 能从 `.agents/skills/` 发现合法 Skill
2. 模型可通过 `activate_skill` 获得完整 Skill 正文
3. 模型可连续调用 `read/write/edit/bash`
4. 写操作不会并发覆盖同一文件
5. Bash 输出会落盘且上下文中只保留截断内容
6. 会话记录为可回放 JSONL
7. 错误为结构化对象，且 session 中可见
8. 至少有 1 个实际业务 Skill 可以完成端到端任务

---

## 25. 建议的首个业务 Skill

建议首个接入 Skill：`intel-bulletin`

原因：

1. 对 Runtime 依赖最完整：读文件、写文件、编辑模板、执行脚本
2. 比多模态 Skill 更容易先验证流程
3. 更适合作为课程作业中的规范化演示用例

最小目录示例：

```text
.agents/skills/intel-bulletin/
  SKILL.md
  scripts/
    render_report.py
  references/
    writing-guide.md
  assets/
    template.docx
```

---

## 26. 开放问题（后续版本）

1. 是否在 v0.2 引入 `AGENTS.md` 自动注入？
2. 是否支持 read-only / safe mode？
3. 是否引入 `permissions.json` 或 trust store？
4. 是否加入 MCP tool adapter？
5. 是否加入上下文压缩？
6. 是否加入 Subagent？

---

## 27. 附录 A：建议的 `SKILL.md` 模板

```md
---
name: intel-bulletin
description: 将多个文档整编为正式报文。适用于情报整编、材料汇总、内参草拟、公文格式输出。
compatibility: Requires Python 3.11+, pandoc, and docx template assets
allowed-tools: read write edit bash activate_skill
metadata:
  author: your-name
  version: "0.1.0"
---

# Intel Bulletin

## When to use
当用户要求：
- 整理多份材料
- 生成正式报文
- 输出 docx/pdf
- 按模板汇总信息

## Workflow
1. 读取任务目录中的材料
2. 提取关键信息与时间线
3. 形成结构化提纲
4. 生成报文草稿
5. 调用脚本渲染到模板
6. 校验输出文件

## Resources
- `references/writing-guide.md`
- `scripts/render_report.py`
- `assets/template.docx`
```

---

## 28. 附录 B：建议的第一批依赖

```json
{
  "dependencies": {
    "zod": "^3.x",
    "gray-matter": "^4.x",
    "yaml": "^2.x",
    "execa": "^9.x",
    "fast-glob": "^3.x",
    "nanoid": "^5.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "tsx": "^4.x",
    "vitest": "^2.x",
    "@types/node": "^22.x"
  }
}
```

---

## 29. 最终建议

开发时遵循这个顺序：

1. 先做 `mock model + runtime loop`
2. 再做 `read/write/edit/bash`
3. 再做 `skills discover + activate_skill`
4. 再接真实模型
5. 最后接业务 Skill

不要一开始就把“业务 Skill、多模态 API、复杂权限系统、UI”混在一起做。

这样可以最快把最难的“Runtime 原理”跑通。
