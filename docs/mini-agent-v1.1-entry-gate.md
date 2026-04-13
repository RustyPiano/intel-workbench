# Mini Agent Runtime：进入 v1.1 前工作清单与准入门槛

- 项目代号：`mini-agent`
- 文档版本：`v1.0`
- 状态：`Draft / 已补充当前 gate assessment`
- 适用范围：Runtime 核心开发、维护者、课程项目规划
- 对应基线：`runtime v1 已实现并通过当前 check/build/test`

---

## 1. 文档目的

本文档用于回答一个具体问题：

**在 `mini-agent` 从当前 working v1 基线进入 `v1.1` 迭代之前，必须先完成哪些收口动作？**

这里的重点不是继续扩功能，而是：

1. 固化当前 v1 基线，避免边开发边漂移。
2. 把上轮 review 修出来的正确性规则反写回规格与文档。
3. 明确 `v1.1` 的边界、优先级和非目标。
4. 为后续承载真实业务 Skill 做准备。

本文件是 **进入 v1.1 的 gate 文档**，不是 v1.1 规格本身。

---

## 2. 当前项目基线

当前树已经具备一个可运行的本地优先 Agent Runtime，主要能力包括：

- runtime agent loop
- JSONL session store
- skill discovery / activation
- built-in tools：`read`、`write`、`edit`、`bash`、`activate_skill`
- OpenAI-compatible model adapter
- CLI：prompt execution、`doctor`、`skills list`、`session list`、`session show`
- 当前 `check/build/test` 全通过

同时，上一轮 review 已经修复了一批关键正确性问题，重点集中在：

- session fidelity 与 replay
- malformed session 检测与保护
- runtime-level tool guardrails
- progressive disclosure 对齐
- provider-side error surfacing

因此，项目当前状态不是“尚未成型”，而是：

**v1 已可用，但需要在进入下一阶段前完成规范收口与工程边界冻结。**

## 2.1 当前 gate 评估（2026-04-13）

基于当前仓库状态、最近一次 handoff、以及已落地的 review 修复，当前 gate 评估如下：

### Gate A：基线稳定

状态：**已满足**

依据：

- `npm run check` 已通过
- `npm run build` 已通过
- 当前 runtime/CLI/config 基线已有文档与 handoff 归档
- 当前 provider error surfacing 已可诊断，不再只有泛化报错

### Gate B：规格收口完成最小闭环

状态：**已满足**

依据：

- `docs/mini-agent-runtime-v1.1-spec.md` 已明确 `Session Grammar`、`Tool Execution Contract`、`Corruption / Recovery`
- 相关 maintainer reference 已拆出：`docs/reference/session-format.md`、`docs/reference/tool-contracts.md`、`docs/reference/model-adapter.md`
- 当前实现已具备 `valid / degraded / corrupted` 状态与 strict / recover load mode
- 当前行为与新增文档已能形成可 review 的 conformance 基线

### Gate C：范围冻结

状态：**已满足（文档层）**

依据：

- v1.1 的非目标已经明确列出
- `streaming / fallback / subagents / richer branching` 等事项已被显式排除在 v1.1 外
- 当前 draft 文档已经把 hardening 与 future capability 分开

### Gate D：运维与诊断准备

状态：**部分满足**

依据：

- 当前仍缺少一个 confirmed known-good provider smoke path
- 最近一次 OpenRouter 实测得到的是 provider-side quota error，而不是稳定可复现的成功路径
- `doctor` 已具备分组诊断输出与 smoke-path 状态展示
- provider 错误类别已经具有明确命名与 surfacing

### Gate E：业务验证方向

状态：**已满足**

依据：

- 首个真实 Skill 已明确选定为 `intel-bulletin`
- 仓库内已有正式输入样本与期望输出夹具：`fixtures/intel-bulletin/source-note.md`、`fixtures/intel-bulletin/expected-report.md`
- 已有 readiness 集成测试覆盖 discover / activate / built-in tools / render path：`tests/integration/intel-bulletin-readiness.test.ts`
- 成功标准已从“能跑”收紧为“渲染结果与固定期望输出一致，且 session 中可见 `skill_activation`”

## 2.2 当前进入判定

当前更适合的判断不是“继续停留在规划阶段”，而是：

1. **允许继续执行 v1.1 的主体 hardening 工作**
2. **允许把已完成事项按 gate 逐项关闭**
3. **在 smoke path 确认前，暂不宣布 entry gate 全部关闭**

换句话说：

- Gate A 已过
- Gate B 已过
- Gate C 在文档层已过
- Gate E 已过
- Gate D 仍需要通过 smoke path 确认来真正关闭

因此，进入顺序应当是：

1. 继续推进 v1.1 主体实现
2. 把 Gate D 作为当前唯一未关闭的 entry-gate 项
3. 避免在 smoke path 未确认前扩展 v1.2 范围

---

## 3. 进入 v1.1 前的总原则

### 3.1 先冻结边界，再扩展能力

进入 v1.1 前，不应继续无节制新增以下内容：

- 新工具类型
- provider fallback 机制
- assistant token streaming
- subagents / parallel orchestration
- 更复杂的 session tree / compaction

这些功能都可能有价值，但它们会扩大状态空间，不适合作为 v1.1 前置任务。

### 3.2 先写清规则，再依赖实现

凡是已经通过 review 暴露出“如果 spec 不写清，后面还会反复出问题”的内容，都必须在进入 v1.1 前完成最小程度的规格收口。尤其是：

- session event-order 规则
- tool execution contract
- corruption / recovery 策略
- activated skill 恢复规则

### 3.3 把 v1 当成稳定基线，而不是过渡废稿

在进入 v1.1 前，应当明确：

- 当前 v1 是有效基线，可继续被使用和回归测试
- v1.1 是在 v1 上做 hardening / operator readiness，不是推翻重写
- 所有新增工作都应尽量以 delta 形式表达，而不是重写总 spec

---

## 4. 进入 v1.1 前必须完成的事项

以下事项是 **进入 v1.1 前必须完成** 的工作，按照优先级排序。

### P0-1 固化 v1 基线

必须完成：

1. 为当前 working tree 形成一份明确的 v1 基线说明。
2. 记录当前已支持命令、配置项、工具列表、会话目录结构。
3. 记录当前已知限制，而不是把限制留在口头沟通里。
4. 将 handoff 中提到的主要修复点整理成 changelog 或 maintainer note。

完成标志：

- 新开发者可以只看文档理解“当前系统已经做到哪一步”。
- 评审可以区分“已完成能力”和“下一步计划”。

### P0-2 冻结 v1.1 之前的非目标

必须明确写出：

- 不纳入 v1.1 的能力
- 仅讨论但不实现的方向
- 进入 v1.2 以后再判断的能力

建议至少列出：

- assistant token streaming
- provider fallback / retry policy
- richer session branching
- subagents
- remote executor / sandbox
- 新的 built-in tool 家族

完成标志：

- 团队或自己在开发时不会把“好想加”的功能偷偷塞进 v1.1。

### P0-3 把 review 修复出的规则反写回规格

必须至少补齐两个部分：

1. `Session Grammar`：事件顺序、恢复规则、损坏判定规则
2. `Tool Execution Contract`：参数校验、timeout、abort、artifact、并发写保护

这是进入 v1.1 的核心门槛。

完成标志：

- 后续 review 可以基于规格做 conformance 判断，而不是“按理解看代码”。

### P0-4 建立 open issue 的结构化分类

必须把当前剩余工作按性质分类，而不是堆在一个 TODO 列表中。

建议分为四类：

1. `spec-hardening`
2. `operator-ergonomics`
3. `maintainer-docs`
4. `future-capabilities`

建议不要把 streaming、fallback、subagent 这类事项与 correctness hardening 放在同一层级。

完成标志：

- backlog 可以按类别与优先级推进。
- issue / 任务命名不再混乱。

### P0-5 选定一个 known-good provider smoke path

进入 v1.1 前，应确定至少一个已验证或计划验证的 provider/model 路径，用于区分：

- runtime/adapter 错误
- provider quota / auth / billing 错误
- model 不支持 tool calling 的错误

该 smoke path 的目的不是做自动 fallback，而是建立一个“系统正常时应该如何工作”的稳定参照。

完成标志：

- `doctor` 或运维文档中有一个明确的、可复现实验路径。

### P1-1 建立 maintainer 文档清单

进入 v1.1 前，至少要把下列文档列入明确产物：

- `docs/session-format.md`
- `docs/tool-contracts.md`
- `docs/model-adapter.md`
- `docs/write-a-skill.md`

此时不要求一次性写到最完善，但至少要建立目录和最小提纲。

完成标志：

- v1.1 不再只有 user-facing quickstart，而开始具有 maintainer-facing reference。

### P1-2 确定第一个真实业务 Skill 目标

进入 v1.1 前，应明确下一阶段要拿哪个 Skill 来验证 runtime。

推荐优先级：

1. `intel-bulletin`
2. `meeting-scene-analysis`
3. `dialog-affect-analysis`

建议将 `intel-bulletin` 作为首个验证 Skill，因为它更适合先验证：

- read / write / edit
- bash orchestration
- artifact 输出
- session replay
- skill activation

完成标志：

- 已选定 skill 名称、目录、输入样本与验收方式。
- 当前仓库中的对应落地点为：
  - `intel-bulletin`
  - `fixtures/intel-bulletin/source-note.md`
  - `fixtures/intel-bulletin/expected-report.md`
  - `tests/integration/intel-bulletin-readiness.test.ts`

---

## 5. v1.1 准入门槛（Entry Gate）

只有当以下条件满足时，项目才应正式进入 `v1.1` 迭代。

### Gate A：基线稳定

必须满足：

- `npm run check` 通过
- `npm run build` 通过
- 当前测试通过
- handoff/基线说明可用
- 当前 CLI 和配置行为已记录

### Gate B：规格收口完成最小闭环

必须满足：

- session grammar 已形成明确章节
- tool execution contract 已形成明确章节
- corruption / recovery 策略已明确
- 当前行为与文档无明显冲突

### Gate C：范围冻结

必须满足：

- v1.1 的 in-scope / out-of-scope 已确认
- future capability 与 hardening 事项已拆开
- backlog 已结构化分类

### Gate D：运维与诊断准备完成

必须满足：

- 已选定 known-good provider smoke path
- `doctor` 的下一轮增强范围已定义
- 关键 provider 错误类别已有命名

### Gate E：业务验证方向明确

必须满足：

- 已确定第一个真实 Skill 目标
- 已准备最小输入样本或测试夹具
- 已定义成功标准（不是“能跑就行”）

---

## 6. 进入 v1.1 前不应该做的事

以下事项不建议作为进入 v1.1 前的工作：

1. 直接增加更多 built-in tools
2. 直接做 streaming assistant text
3. 在没有 smoke path 的情况下做 provider fallback
4. 一边修规范一边接多种 Skill
5. 重写 session store 或 model adapter
6. 为了“更优雅”推翻当前 working v1 结构

原因很简单：这些工作会放大变量，导致你失去当前已经建立起来的基线价值。

---

## 7. 建议的进入前任务顺序

推荐执行顺序如下：

1. 固化 v1 基线说明
2. 冻结 v1.1 非目标
3. 补写 session grammar
4. 补写 tool execution contract
5. 结构化整理 backlog
6. 确定 known-good provider smoke path
7. 建立 maintainer docs 清单
8. 选定首个真实 Skill
9. 正式进入 v1.1

---

## 8. 进入 v1.1 前的交付物清单

完成本阶段时，仓库或项目文档中应至少存在：

1. 一份 v1 基线说明或 handoff 归档
2. 一份“进入 v1.1 前工作清单”文档（即本文）
3. 一份 v1.1 规格文档
4. `Session Grammar` 与 `Tool Execution Contract` 的明确章节
5. maintainer 文档提纲
6. 一个已指定的 smoke provider 路径
7. 一个已指定的首个真实 Skill 目标

---

## 9. 结论

`mini-agent` 当前已经具备 working v1 基线，因此进入 v1.1 前的重点不应再是“继续加功能”，而应是：

- 冻结基线
- 收口规格
- 拆分边界
- 建立诊断参照
- 准备真实 Skill 验证

只有先完成这些动作，`v1.1` 才会是一次有边界、有目标、可验证的迭代，而不是另一轮边写边猜的开发。
