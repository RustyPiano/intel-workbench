# 情报分析工作台 · 三期工程方案（Agent Harness 转向）

> 一期：`intel-workbench-phase1-engineering-plan.md`（M0–M5，结构化 RAG 流水线）。
> 二期：`intel-workbench-phase2-engineering-plan.md` + `...phase2-multimodal-rag-spec.md`（多模态加工 + 混合检索，P2.0–P2.5 mock 完成，P2.6 阻塞于本地模型部署）。
> 本文是**范式转向**：把当前"绕过 harness 的单发结构化流水线"改造为"agent 在 harness 内自由编排、红线作为 harness 不变量"的形态。
>
> **部署假设（v2.2 新增，根本前提）**：整个程序部署在**物理不通外网**的气隙机器（内网/专网）上。**网络隔离本身就是 egress 控制**——外发到公网无路由、发不出去。故沿用项目最初锁定决策"zero-egress via air-gap，**保留全部工具含 `bash`**"。OfflineGuard 不再是"挡 bash 的唯一墙"，而重定位为"给应用自身模型/slot 调用做授权 + 审计留痕（防御纵深）"。
> **残留风险（部署方决策，非本程序范围）**：(a) 专网内横向——bash 可达专网其他主机，若需专题/部门间隔离须靠网络层（防火墙），应用层拦不住；(b) 提示词注入驱动的本地越权读（bash 不限于 workspace），靠 OS 层（低权限用户/文件权限）缓解。
>
> **v2.3（已过 opus xhigh 两轮对抗式评审，均 SOUND-WITH-FIXES）**。
> 一轮（v1→v2）：B1 bash 触网 / B2 两道 guard 闸 / B3 工具注入语义 + 4 重大项（M1 cite 台账 / M2 journal→审计 / M3 element&report 保留 generateJson / M4 本地模型 tool-calling）。
> 用户加气隙部署假设后 v2.2 撤 B1（网络隔离即 egress 控制，bash 保留，P3.0 简化为"追加"语义）。
> **二轮（v2.2→v2.3）揪出新阻塞 B1′**：撤 B1 只处理了"外发"维度，**遗漏 bash 对本机审计/溯源文件的写权限**（与外发正交，气隙无用）——可整体重写审计日志、伪造 chunk+manifest 通过 cite 校验、跨专题读。处置 = 数据根与 agent workspace 物理隔离 + chunk 只经 service 工具 + OS 文件权限（升级为部署红线前提）+ 审计外部锚定（§4.4），并删除"应用层保证伪造不了证据"的虚假声明。
> **二轮修正 M2′**：审计同步在 EventBus 上 await 不了（同步 fire-and-forget + 仅预览），改为 core `LoopDependencies` 的可 await **工具中间件**（§4.3）。
> 二轮采纳的更优设计：统一 `IntelHarness` 注入层、cite 台账→证据图、内容寻址只读 chunk 视图、审计中间件并入 P3.0。
>
> **v2.4（已过 codex xhigh 第三方独立评审，NEEDS-REWORK → 已并入）**。Codex（不同模型）揪出两轮 Opus 的盲区，4 新阻塞：
> - **C-B1（架构级，已决策=隔离 worker）**：v2.3 的"OS 文件权限保护 cases/audit"在**同进程下不成立**——bash 是 server 同一 OS 用户的子进程，`AuditService` 也是该用户写，OS 权限挡不住同 UID。**决策：agent + bash 跑在低权限独立 worker（进程/容器），只挂 scratch、碰不到 cases/audit；可信 server 经 IPC 暴露 `search/read/cite/finalize` 服务工具。** 这才是真信任边界（§1、§4.4）。
> - **C-B2（finalize 契约）**：core loop 返回**自由文本** `finalMessage.content`，agent 可在最终答案塞未 cite 的新断言，ledger 约束不住。须加强制 `finalize_answer({claims})`，Inquiry 只从 finalize+ledger 生成，无 finalize 判 insufficient，raw text 不入库（§4.2）。
> - **C-B3（write-ahead 审计）**：有副作用工具（write/edit/bash）的副作用先于审计 append，失败/超时致不一致。须 write-ahead（先记 intent 再记 result）；P3.A worker 内只放只读 service 工具（§4.3）。
> - **C-B4（run 级注入）**：`toolRegistry` 是 `RuntimeAgent` **实例字段**，闭包注入 ledger/caseScope/actor 若在 agent 级，**并发 ask 串线泄漏**。注入须 **run/会话级**或每 ask 建独立 worker（§3.0）。
> 并补重大项：agent 循环 context 预算（防长文档撑爆本地模型）、stream 事件协议先定、guard 装饰器带 {actor,caseId,runId}、子 agent 独立 ledger + 显式 merge_evidence。
>
> **v2.5（已过第四轮 Opus + Codex 并行复审，两家独立收敛到同一结论 → 已并入）**。两家一致认定：**红线正确性已收敛（SOUND）**，前三轮全部阻塞正确闭合、core 现状诊断属实。**但 v2.4 在 C-B1 上过度修正**——"per-ask 隔离 worker + 全工具 IPC 代理"是最重的一档解法，且 core 是单进程同步工具循环、**无 RPC 层**（搬进程要重造 IPC + session JSONL 归属 + skill 加载 + worker 生命周期，被严重低估），违反 CLAUDE.md §2。
> **关键洞察（两家相同）**：C-B1 威胁 100% 来自 agent 路的 `bash`/`write`/`edit`（唯一能用绝对路径碰 audit/cases 的工具）；而 **P3.A 问答只给只读服务工具**（search/read/cite/finalize，server 侧强制校验、无任意写）——**进程内跑也碰不到红线资产，故 P3.A 不需要进程隔离**。
> **v2.5 修正（做减法）**：① P3.0 = finalize 契约 + run 级注入 + write-ahead 中间件（**全是 core 进程内小改**）；② P3.A 问答**进程内 + 只读服务工具**，三红线照样成立；③ **进程隔离降级为按需里程碑 P3.0-iso**，仅在真给 agent `bash`/`write` 时触发（P3.B+），且届时**只隔离 bash 这一个工具的执行身份**（降权子进程），不搬整个 agent 循环。C-B1 的威胁分析仍成立，只是修法从"提前全隔离"改为"按需、最小隔离"。

---

## 0. 给接手 Agent 的上手须知（先读这段）

**这次改什么、为什么改**

当前情报工作台的问答/要素抽取走的是 `generateJson()` —— **单次结构化 LLM 调用 + 事后 Citation 过滤**（`inquiry/inquiry-service.ts:218`、`elements/element-service.ts:132`、`model/structured.ts`）。这条路径为了守溯源红线，把模型输出塞进固定 JSON schema 单发，**代价是 agent 不能多轮推理、不能自己决定深挖、不能调工具**。

但这是个 **agent 项目**：目标是做一个 **Harness**，让 agent 在 harness 范围内充分发挥（多轮、自编排、按需调工具），保证任务顺利执行。当前形态把 agent 的认知能力锁死了，方向偏了。

**关键洞察（务必内化）**：core 本身**已经是一个 harness**（`RuntimeAgent.create` + 工具调用循环 + 技能系统 + 会话 JSONL 自动留痕，见 `packages/core/src/runtime/`），基本是个迷你 Claude Code。问题只是 **server 业务层没用它**——`index.ts:22` 里 `RuntimeAgent` 只被当成接线自检。本次转向 = **把情报业务接进已有的 harness，并把三条红线从"笼住 agent 输出"改为"长在 harness 边界与工具契约上"。**

**范式公式**：

> 红线不长在 agent 的输出上，而长在 harness 的边界与工具契约上。
> agent 在 harness 内**想象力不设限**；harness 边界**让它无法越界**——不靠 agent 自觉，靠环境不设越界的工具。

**三条红线 → 三个 harness 不变量**

| 红线 | 旧（笼住输出） | 新（harness 不变量 / 工具契约） |
| --- | --- | --- |
| 零外发 | —— | 模型适配器 + 任何触网工具调用前过 `OfflineGuard.authorize`；agent 没有能外发到白名单外的工具 |
| Citation 溯源 | 输出塞 schema + 事后 `resolveValidCitations` 过滤 | `cite(chunk_id, claim)` 工具：调用时校验 `sha256(text)===content_hash`、写入溯源台账；无 cite 的结论标"待核"（不藏、不拦） |
| 审计链 | 业务手动 append | harness 本就把每次工具调用落 session journal → 把 journal 事件包进 `AuditService` 哈希链，agent 全程无感 |

**怎么跑 / 门禁（不变）**：`npm install` → `npm run build`（先建 core）→ `npm run dev:server`(:4319) + `npm run dev:web`。门禁 `npm run check`（typecheck 全包 + `vitest run`）。**当前基线 424 通过 / 2 跳过，任何里程碑必须保持绿，新增测试只增不减。**

**三条红线回归是硬门**：任何里程碑后，`cite` 对伪造/篡改 chunk 仍拒、`OfflineGuard` 对未白名单端点仍 403、审计链仍 verify ok。

**先做骨架、保留兜底**：每个里程碑保持新旧两路并存可对比；A 期不删 `generateJson` 路径，先让 agent 路与单发路并行，验收通过再逐步切主。

---

## 1. 核心范式：红线落在工具能力上，隔离按需叠加（v2.5）

第四轮两家复审收敛的结论：**红线的第一道防线是"agent 路里有没有能任意写的工具"，不是进程隔离**。只读服务工具（server 侧强制校验、无任意文件系统写）进程内跑也碰不到 audit/cases；只有引入 `bash`/`write`/`edit`（能用绝对路径碰红线资产）时，才需要叠加进程/身份隔离。

```
  P3.A（问答，进程内）：agent 只拿只读服务工具 —— 三红线靠工具契约成立
  ┌──────────────────────────────────────────────────────────────┐
  │ Agent：自由推理·多轮·自编排（认知不受限）                        │
  │ 工具（IntelHarness per-ask 注入 ledger/caseScope/actor）：       │
  │   search_chunks / read_chunk / cite / finalize_answer           │  ← 均只读/受控，无任意写
  │ 红线落点（server 侧一处强制）：                                   │
  │   OfflineGuard 两道闸 · cite 台账+sha256 · finalize · 审计中间件  │
  └──────────────────────────────────────────────────────────────┘
            ▲ 进程内同步调用，无需 IPC（core 现状即可）

  P3.0-iso（按需，仅当给 agent bash/write 时，P3.B+）：只隔离能任意写的工具
  ┌──────────────────────────────────────────────────────────────┐
  │ bash/write 在降权子进程执行（OS 用户≠server，只触 scratch）       │
  │ —— 不搬整个 agent 循环，只隔离这一个工具的执行身份               │
  └──────────────────────────────────────────────────────────────┘
```

**设计要点**：
1. **agent 认知完全不受限**：规划、推理、工具选择、多轮——放手。
2. **P3.A 不给 `bash`/`write`/`edit`**：问答只需检索-读-引-定稿；只读服务工具无任意写能力，agent 进程内也**碰不到** audit/cases，C-B1 攻击面在 P3.A **不存在**。
3. **红线在 server 侧一处强制**：cite hash 校验、finalize、两道 guard 闸、审计中间件——都在受信的 server 服务实现里，进程内同步调用即可（无需 IPC）。
4. **隔离是按需的最小叠加**：真要给 agent `bash`（深挖分析，P3.B+）时，才把 **bash 这一个工具**的执行降权隔离（C-B1 威胁分析仍成立，但用最小手段闭合）。
5. **气隙是外发第一道防线**；OfflineGuard 是 server 侧应用层授权+审计（防御纵深）。

---

## 2. 里程碑总览

| 里程碑 | 名称 | 模型依赖 | 产出 |
| --- | --- | --- | --- |
| **P3.0** | run 级注入 + 中间件 + finalize（进程内小改） | 无 | core 加 run 级 `extraTools`/`toolMiddleware`（write-ahead）+ `finalize_answer` 契约；**纯进程内、默认行为不变**，阻塞后续 |
| **P3.A** | 问答接进 harness（进程内，只读工具） | 无（本地文本 LLM） | 只读服务工具（search/read/cite/finalize）进程内 + agent 循环问答 + 审计同步 + context 预算 + 本地 LLM 切换；三红线靠工具契约成立 |
| **P3.0-iso** | 按需：bash/write 执行隔离 | 无 | **仅当给 agent bash/write 时触发**（P3.B+ 前）；只隔离该工具的执行身份（降权子进程），不搬 agent 循环 |
| **P3.B** | skill=提示词管理 + 按需多模态 + 对话式 UI | mock 多模态 | 硬编码 prompt → 可编辑 skill；`transcribe/caption/ocr` 工具；core `stream()` 补实现 + 前端流式会话面 |
| **P3.C** | 多 agent 编排 | 同上 | `spawn_subagent` 工具 + 编排器/子 agent 模式，子 agent 产出仍过 cite 台账 |
| **P3.D** | 真实本地模型接入（原二期 P2.6） | **阻塞于部署** | FunASR/VLM/Embedding 真端点替换 mock + 头对头评测 |

P3.0–P3.C **现在就能做**（本地文本 LLM + mock 多模态）；P3.D 阻塞于本地模型部署（用户范围外）。

---

## 3. 里程碑细化

### P3.0 run 级注入 + 工具中间件 + finalize 契约（进程内小改，**最先做**）

**目标**：把 C-B2/B3/B4 三个**纯进程内**地基建好——core 默认行为不变、424 不破，立刻能验。（C-B1 的进程隔离降级为按需里程碑 P3.0-iso，见下。）

**现状陷阱（已核实）**：
- `RuntimeAgentOptions`（`agent.ts:19-34`）不接受自定义工具；`toolRegistry`（`agent.ts:144`）是 **`RuntimeAgent` 实例字段**，`createConversation` 复用 `this.agent.toolRegistry`（`agent.ts:94-97`）——**故 agent 级闭包注入会在并发 ask 间串线（C-B4）**。
- `ToolRegistry` 构造用 `Map.set` 静默覆盖（`tools/index.ts:54-57`）。
- core loop 返回自由文本 `finalMessage.content`（`loop.ts:155-160`）——无 claim 边界（C-B2）。
- `Promise.race` 超时后 `write/edit` 不检查 signal、执行体继续（`tools/index.ts:127-154`，`write.ts:68`）——副作用与审计可能不一致（C-B3）。

**新增/改（全部进程内）**：
1. **run 级注入（C-B4）**：给 core 加 **conversation/run 级** `extraTools` + `toolMiddleware`（不放 `RuntimeAgent` 实例级共享）。`ledger`/`caseScope`/`actor` 经 `IntelHarness` 每次 `ask` 构造、闭包注入服务工具。两并发 ask 不串线。
2. **工具中间件（C-B3 / M2′）**：`LoopDependencies` 加可 await 的 `toolMiddleware?(toolCall, next): Promise<result>`。只读服务工具失败即无脏数据；有副作用工具（P3.0-iso 后才引入）走 **write-ahead**（§4.3）。
3. **finalize 契约（C-B2）**：加 `finalize_answer({claims:[{text, cite_ids}]})` 工具。`Inquiry` **只从 finalize payload + ledger 生成**；未调用 finalize → 整体 `insufficient`，**raw final text 不入库**。注意 `loop.ts:179-181` 把"无 tool call 的 assistant message"当 final——finalize enforcement 在 server 侧组装 Inquiry 时判定（无 finalize 即 insufficient），不依赖改 core loop。
4. **同名冲突 → 报错**（不静默覆盖）。

**P3.A 不引入 `bash`/`write`/`edit`**：问答只用只读服务工具，故 P3.0 不需要进程隔离，core 单进程同步工具循环即可（无 IPC）。

**验收**：run 级注入下两个并发 ask 的 ledger/caseScope **不串线**（C-B4 回归）；`toolMiddleware` 可 await、抛错使 ask 失败、拿完整 payload；无 finalize 的 ask 判 insufficient、raw text 不入库；同名冲突抛错；不传 extraTools 时行为与现状完全一致（既有 424 全绿）。

---

### P3.0-iso 按需执行隔离（**仅当给 agent `bash`/`write` 时触发**，P3.B+ 前）

**触发条件**：只在决定给 agent `bash`/`write`/`edit`（深挖分析、跑脚本）时才做——P3.A 问答不触发。

**为何按需**：C-B1 威胁（bash 经绝对路径改审计/伪造 chunk/跨专题读）100% 来自能任意写的工具。P3.A 不给这些工具 → 攻击面不存在 → 进程隔离是为未来需求提前付费（违反 CLAUDE.md §2）。第四轮两家复审一致结论。

**做法（最小隔离，不搬 agent 循环）**：
- **只隔离 `bash`/`write` 这一个工具的执行身份**：工具 `execute` 时 spawn 一个**降权子进程**（OS 用户 ≠ server，对 `cases/`/`audit/` 无权限，cwd/可写范围限 scratch）执行命令；agent 循环、session、审计中间件**仍在 server 进程内**（不动）。
- 审计外部锚定：server 周期性把末位 `event_hash` 写入仅特权可写位置，使任何重写可被发现。
- 若届时评估"只隔离 bash 不够"（如 agent 要复杂多工具沙箱协作），再评估是否升级为完整 worker——但**那是届时的决策，带独立的延迟/IPC/生命周期量化**，不在本期预先承诺。

**验收**：降权子进程对 `cases/`、`audit/` 不可读不可写（OS 隔离冒烟）；bash 写只落 scratch；审计锚点能发现整体重写。

---

### P3.A 问答接进 harness（无新模型依赖，**证明范式的垂直切片**）

**目标**：问答从"单发结构化"改为"agent 在 harness 内自由检索→读→引→答"，红线作为不变量全程不破。

**核心机制：per-ask CitationLedger（评审 M1）**。工具之间无共享态（`agent.ts:104-117` 每次工具调用新建 context），故每次 `InquiryService.ask` 构造**一个** `CitationLedger { retrieved: Map<chunk_id, Chunk>; cited: Citation[] }`，search/read/cite 三工具构造时**闭包捕获同一实例**：`search_chunks` 把命中 chunk 写入 `retrieved`；`cite` 只接受 `retrieved` 里已检索过的 chunk_id（防 agent 凭空 cite 未检索内容）。

**新增情报工具（server 侧，工厂函数闭包注入 service + ledger + {caseId, actor}）**：
- `search_chunks(query, modality?, k?)` → 复用 `inquiry/retrieval.ts` 的 `retrieveHybrid`/`selectContext`，返回 `[{chunk_id, snippet, locator, content_hash, material_name}]`，并写入 ledger.retrieved。**只读、锁定本专题作用域**（评审 N2：工具内固定 `caseId`，不接受跨专题参数）。
- `read_chunk(chunk_id)` / `read_material(material_id)` → 复用 `material-service.loadCaseChunks`/`getContent`，**同样锁定本专题**（防 agent 按全局 chunk_id 越权读他专题，绕过 `cases.get(actor, caseId)` 的密级校验）。**只读**。
- `cite(chunk_id, claim)` → **溯源台账工具**：从 `ledger.retrieved` 取 chunk，**直接 import 复用** `inquiry/citation.ts:resolveValidCitations` 的 hash 校验（评审 M1：不 copy，避免 core 红线逻辑分叉）；通过则把 `Citation` 写入 `ledger.cited` 返回 ok，失败返回明确错误（agent 可换证据重试）。
- `finalize_answer({claims})` → 见 §4.2，最终结论唯一入口（C-B2）。
- **actor 透传（评审 N3）**：actor 身份经 `IntelHarness` per-ask 上下文进每个服务工具，供 `guard.authorize` 的 `user` 与审计 `user` 字段。

**改**：
- `InquiryService.ask`（**v2.5：进程内，不起 worker**）：经 `IntelHarness` per-ask 构造 `{ledger, caseScope, actor, auditSink}`，run 级注入只读服务工具，调 `send(question)`；**ledger/caseScope/actor 绑定到这次 run，不在 agent 实例级共享（C-B4）**。结束后 `Inquiry` 只从 `finalize_answer` payload + ledger 生成（C-B2）。只读服务工具在 server 进程内直接调受信实现（无 IPC），返回内存 chunk + 即时 hash 校验；**不给 `bash`/`write`/`edit`，故 agent 进程内也碰不到 audit/cases**。
- **context 预算（C-Major）**：agent 循环每轮发全量 messages（`loop.ts:141-150`），长文档会撑爆本地模型。`search_chunks` 默认只回 snippet+id，`read_chunk` 设 byte/token cap，历史滚动摘要，硬性沿用 `selectContext` 的 `CTX_BUDGET`。
- **保留** `generateJson` 旧路径作为降级/对比（env 开关 `MINI_AGENT_INQUIRY_MODE=agent|single`，默认先 `single`，A 期验收后切 `agent`）。
- **审计**：服务工具经 §4.3 工具中间件**同步**落 `AuditService`（server 进程内写；P3.A 不给 bash/write，agent 无法碰审计文件）。

**零外发落点（评审 B2 修正：两道独立闸，不是一道）**：
- 文本 LLM 与多模态 slot **是两类不同接口的出站**（`ModelAdapter.generate` 自发 HTTP，`openai-compatible.ts:337`；slot 适配器各自发 HTTP，授权现在在 `inquiry-service.ts:124/140`、`element-service.ts:72` 调用点手写）。一个装饰器拦不住两类。
- **闸 (a)**：`ModelAdapter` 装饰器，`generate()` 前 `authorize(endpoint)` —— 拦文本 LLM（agent 路与单发路共享此闸）。
- **闸 (b)**：每个 slot 适配器各自 guard-aware 包装，**或**在 `transcribe/caption/ocr` 工具 `execute` 入口统一 `authorize` 后再调 slot —— 拦多模态出站。
- **空 endpoint 旁路风险（评审 B2）**：mock 适配器 endpoint=`""` 时跳过授权（`app.ts:105/107`）。real 切换时必须断言 endpoint 非空，否则 guard 静默旁路——加规则"endpoint 为空即视为未配置、禁止 real 路径"。

**本地文本 LLM 切换（老师 #2）**：把开发文本 LLM 从云端 DeepSeek 改为本地端点（Ollama/llama.cpp/vLLM 的 OpenAI 兼容口）。纯配置：`MINI_AGENT_BASE_URL` 指向本地，`OfflineGuard` 白名单换成本地 host。验收一个本地小模型（如 Qwen2.5-7B-Instruct）能驱动 agent 循环。

**验收**：
- agent 多轮问答端到端跑通；回答含 `verified`/`待核` 标注。
- **红线回归（硬门）**：`cite` 对伪造 chunk_id / 篡改文本（hash 不符）拒绝；`OfflineGuard` 对白名单外端点 403 + 审计；审计链 `verify()` ok 且含 `search/read/cite/egress` 事件。
- 三拒答/降级路径保留：专题零 chunk → agent 应答"材料不足"；全 claim 无有效 cite → 整体标 insufficient/待核。
- 新旧两路可 env 切换、可对比；既有 424 测试不减。
- **本地 LLM 功能性门槛（评审 M4，存在性风险）**：必须验证本地模型**实际触发 tool-calling**（不只是"质量可用"）。core 用 OpenAI strict function-calling（`openai-compatible.ts:232` `strict:true`），很多本地 7B function-calling 弱。若驱动不了工具循环，需降级方案（放宽 `strict` 或退回 single 模式）。验收硬指标：(a) scripted model adapter 做确定性多轮回归，断言台账/审计/状态；(b) 本地模型冒烟须见到工具被真实调用 + 端到端延迟在预算内（见 §7）。

---

### P3.B skill=提示词管理 + 按需多模态 + 对话式 UI（老师 #4）

**目标**：提示词进入可管理形态；agent 能主动深挖原始素材；前端从单轮问答升级为流式会话。

**element-service / report-service 的去向（评审 M3，明确不含糊）**：**保留 `generateJson` 单发，不强上 agent 循环**。要素抽取是"全量→抽实体→每实体挂 mention"（`element-service.ts:53` 的 `extract`/`buildElements`），结构化程度高、不是"检索→引→答"，强套 agent 工具契约违背 CLAUDE.md §2 简单优先。report 生成同理保留。**三期 agent 化只针对问答**；element/report 仅在下面做 prompt skill 化（提示词外置，不改执行模型）。

**skill = 提示词管理**：
- 把硬编码的 system prompt（`inquiry-service.ts:210`、`element-service.ts:124`）抽成**可编辑、可版本化的 skill**（复用 core 的 `skills/` discover/parse/registry）。情报工作流（要素抽取、研判报告、音视频研判）各成一个 skill。
- 后台"提示词模板"从只读（`web/src/pages/Admin.tsx:47`）改为 **skill 管理**：编辑、启停、版本、自检（`admin-service.ts` 已有 skill 列表/启停/自检骨架）。
- agent 通过 `activate_skill` 自行加载相关方法论——**skill 是引导不是禁锢**，agent 仍自由推理。

**按需多模态工具**：
- `transcribe(material_id, t0?, t1?)` / `caption_frame(material_id, t)` / `ocr_region(material_id, bbox)`：调对应适配器槽（`model/slots.ts`，A/B 期仍 mock），每次过 `OfflineGuard`。让 agent 在检索不足时**主动凑近再看**（重转写一段、重 OCR 一块区域）。
- 仍保留二期"ingest 预加工产 chunk 供检索"的杠杆点；按需工具是**补充**而非替代。

**对话式 UI（老师 #4）**：
- **补 core 的 `stream()`（评审 N1：是完全缺失的 optional 方法，不是空壳，工作量被低估——本期最重单项，建议拆为独立子里程碑 P3.B-stream）**：`model/types.ts:32` `stream?()` 未实现；要做 SSE 流式解析 + 流式 token/工具调用**增量组装**回 `AssistantMessage`（现 `mapToolCall`/`mapAssistantMessage` 是一次性的）+ 给 `loop.ts:141`（现硬用 `generate()`）加流式分支 + 先定义 `AsyncIterable` 的事件类型。
- 前端加**流式会话面**：展示 agent 推理 + 工具调用轨迹 + 内联可点 citation（点开回听音频 timecode / 框选帧 bbox，复用现有 `BboxImage`/`playCitedSegment`）。形态参考主流 AI 对话平台 transcript。
- 保留现有面板（素材/要素/报告/审计）作为"harness 检视器"。

**验收**：skill 可在后台编辑并被 agent 激活、版本可回溯；按需多模态工具产出经 `cite` 可溯源；前端流式逐 token 渲染，工具调用与 citation 可视且可回放；红线回归硬门仍过。

---

### P3.C 多 agent 编排（老师 #3）

**目标**：agent 能派生子 agent 并行调查，子 agent 产出仍守红线。

**新增**：
- `spawn_subagent(task, scope?)` 工具：派生子 run（每个子 agent 独立 ledger，**进程内**，沿用 P3.A 只读工具）。核实 core 嵌套会话；不支持则 server 侧再起一个受限 run。
- 编排模式：编排 agent 拆解任务 → 派检索/转写/写作子 agent 并行 → 汇总。
- **并发台账合并（C-Major）**：**每个子 agent 独立 ledger**，父 agent 只能经显式 `merge_evidence(subRunId)` 合并子 agent 的证据，合并事件进审计——避免共享 ledger 的顺序/去重/父子引用归属不确定（现工具调用是顺序 for，`loop.ts:184-242`，并行子 agent 共享态会乱）。
- **红线不变**：每个子 agent 结论仍须经 `cite`+`finalize`；所有子 agent 工具调用经中间件进审计；子 agent 同样只读工具、用 guard-aware adapter（若子 agent 需 bash 则各自走 P3.0-iso 降权执行）。
- 防 runaway：子 agent 数量/深度硬上限 + spawn 计数。

**验收**：编排 agent 派 ≥2 子 agent 并行完成复合研判；各子 agent 独立 ledger、经 merge_evidence 汇总且可溯源；审计含各子 agent 事件且 verify ok；数量/深度上限生效。

---

### P3.D 真实本地模型接入 + 评测（**阻塞于部署**，原二期 P2.6）

- FunASR（fsmn-vad + ASR 槽 + cam++）、VLM（MiniCPM-V 4.5 / Qwen3-VL）、Embedding/Reranker（Qwen3 系）以本地 HTTP 端点暴露，real adapter 替换 mock。
- 真实截获素材头对头评测（精度/时间戳/显存/速度），定引擎、定 `CTX_BUDGET`、定是否上重排。
- **此里程碑只在模型就绪后做**；P3.0–P3.C 已把 harness、工具、guard、审计全部备好，real adapter "插上即用"。

---

## 4. 红线作为不变量的具体实现（评审重点）

1. **零外发（气隙为主、guard 为辅，评审 B2）**：**第一道防线是网络隔离**——气隙机器物理不通外网，bash/任意工具都发不出公网（见部署假设）。**第二道是 OfflineGuard 做应用层授权 + 审计留痕（防御纵深）**：应用自身的两类出站——文本 LLM（`ModelAdapter`）与多模态 slot（不同接口）——各自过闸。**闸 (a)** 装饰 `ModelAdapter.generate`；**闸 (b)** 各 slot / 多模态工具入口各自 `authorize`。`generate/embed/transcribe/caption/ocr` 前一律 `OfflineGuard.authorize(endpoint, {user, purpose})`，且 endpoint 非空才允许 real。bash 等工具的网络能力由网络隔离兜底，不靠 guard 拦（guard 也拦不到子进程）。
2. **Citation 溯源（C-B2：cite 台账 + finalize 契约，两者缺一不可）**：`cite(chunk_id, claim)` 是"接地"通道，校验 `sha256(text)===content_hash`，台账只接受本会话检索过的 chunk。**但 cite 台账约束不住自由文本最终答案**（agent 可在 `finalMessage` 塞未 cite 的新断言，`loop.ts:155`）——故加强制 `finalize_answer({claims:[{text, cite_ids}]})`：**`Inquiry` 只从 finalize payload + ledger 生成，raw final text 不入库**；未 finalize → 整体 `insufficient`。`Inquiry.status`：claim 的 cite_ids 全在 ledger 且 hash 通过 → verified；部分 → 部分待核；无 → insufficient。**待核标注而非拦截**，不限制 agent 表达，只标注接地状态。
3. **审计链（评审 M2′ 修正：工具中间件，不是 EventBus 旁路）**：harness 的 journal 写在 core `loop.ts`，与 server `AuditService` 无连接。**EventBus 不行**——`EventBus.emit` 同步 fire-and-forget、listener 签名 `(event)=>void`（`events.ts:35`）无法 await，且事件只带**截断预览**（`run-manager.ts:184/228` 的 `previewValue`），审计取证价值打折。**正解：给 core `LoopDependencies` 加可选 `toolMiddleware?(toolCall, next): Promise<result>`**（评审"工具中间件"想法）。server 注入中间件，在 `next()` 前后 `await audit.append(完整 args + result)`；抛错自然冒泡使 `send`/`ask` 失败（HTTP 500）。中间件与工具执行**同一 await 链**，拿到**完整** payload（非预览），P3.C 子 agent 可复用。`action` 命名 `tool.<name>`，完整 args 放 `detail`，detail 标准化加 `caseId/sessionId/runId/toolCallId/seq`（评审 min1）。
   - **write-ahead（C-B3：有副作用工具非原子）**：只读服务工具（search/read/cite）失败时无落盘脏数据，但 `write/edit/bash` 副作用先于审计、且 `Promise.race` 超时后执行体仍继续（`tools/index.ts:127-154`，`write.ts:68` 不查 signal）。故有副作用工具走 **write-ahead**：`next()` 前 append `tool.<name>.intent`（含完整 args），成功后 append `.result`；超时/抛错下 intent 已留痕，审计可见"发起但未确认"。**P3.A 的 worker 内先只放只读服务工具**，副作用工具（含 bash 写 scratch）留到 write-ahead 稳定后再开。EventBus 留给 UI/trace（本就 fire-and-forget）。
4. **bash 与本机攻击面的处置（v2.4：隔离 worker，C-B1 决策）**：
   - **问题回顾**：气隙挡外发，但 bash（`tools/bash.ts:315` `spawn(shell:true)`）在**本机**能经绝对路径（`resolveExecCwd` 只管 cwd 不解析命令，`policy.ts:117`；数据根默认 `process.cwd()`，`paths.ts:50`）：(a) 整体重写 `audit/audit.jsonl`（`verify()` 在被整体重写的文件上仍 ok）；(b) 写伪 chunks + 改 manifest + 自算 content_hash 骗过 `cite`（`citation.ts:32` 不校验来源）；(c) 跨专题读。**这与外发正交，气隙无用。** v2.3 想靠 OS 文件权限兜底，但 **Codex 指出：bash 是 server 同一 OS 用户的子进程，AuditService 也是该用户写，OS 权限无法区分同 UID——不成立。**
   - **决策（v2.5，第四轮收敛）：按需最小隔离，不预先搬进程**。
     1. **P3.A 问答不给 `bash`/`write`/`edit`** → 只读服务工具无任意写、碰不到红线资产 → **攻击面在 P3.A 不存在，进程内跑即安全**。这是第一道、也是 P3.A 唯一需要的防线。
     2. **真给 agent `bash`/`write` 时（P3.B+，P3.0-iso）才隔离，且只隔离该工具的执行身份**：spawn 降权子进程（OS 用户≠server、对 cases/audit 无权限、只触 scratch）执行命令；agent 循环/session/审计仍在 server 进程内。**不把整个 agent 循环搬 worker、不引入全工具 IPC**（core 无 RPC 层，那是独立里程碑级工程，被 v2.4 低估）。
     3. **审计外部锚定（补强）**：server 周期性把末位 `event_hash` 写入仅特权可写位置，使任何重写可被发现。
   - **结果**：bash 与 agent 能力按需保留（P3.0-iso 后在降权身份内随便跑），红线在 P3.A 靠"工具无任意写"成立、在 bash 引入后靠"该工具降权执行"成立——都不靠"应用层声称"或"同 UID 权限"，且把复杂度推迟到真正需要的那一刻。

---

## 5. 保留 / 降级 / 新增

**保留（harness 资产，不动）**：core agent 循环 / 工具系统 / 技能系统 / 会话 JSONL；`OfflineGuard`；`AuditService`；`FileMutationQueue`；适配器槽（ASR/VLM/OCR/Embed/Rerank）；chunk/素材持久化；角色 + 密级；检索算法（BM25⊕dense RRF + rerank）。

**降级（保留作兜底，不再是主路径）**：`inquiry-service.ts`/`element-service.ts` 的 `generateJson` 单发路径（env 开关切换）。

**新增**：run 级工具注入 `extraTools` + 可 await 的 `toolMiddleware`（write-ahead，C-B3/B4，**进程内**）；`finalize_answer` 契约（C-B2）；`IntelHarness` 统一注入层（ledger/caseScope/actor/auditSink）；情报工具包（search/read/cite/finalize/transcribe/caption/ocr/draft/spawn_subagent）；两道 guard-aware 闸（model adapter + slot，带 {actor,caseId,runId}）；审计外部锚定；agent 循环 context 预算；skill 化提示词；core `stream()` + 事件协议；前端流式会话面；**（按需 P3.0-iso）bash/write 降权子进程执行**。

**工具集（v2.5）**：**P3.A = 只读服务工具**（search_chunks/read_chunk/cite/finalize_answer），进程内，不给 bash/write/edit → 无任意写攻击面。**P3.B+ 若引入 bash/write**，该工具走降权子进程（P3.0-iso）。**不预先引入全工具 IPC / worker 进程**（core 无 RPC 层，避免过度工程）。

---

## 6. 测试与验收策略

- 每里程碑配 service 级 vitest（临时 dataDir + mock 适配器 + scripted model adapter 重现 agent 多轮）。
- **红线回归硬门**（每里程碑后）：`cite` 拒伪造/篡改、`OfflineGuard` 拒未白名单、审计链 verify ok。
- **agent 路新增必测**：① run 级注入：两并发 ask 的 ledger/caseScope/actor **不串线**（C-B4）；② **两道闸**分别拦文本 LLM + 每个 slot 端点、带 {actor,caseId,runId}、空 endpoint 禁 real（B2/M3）；③ `toolMiddleware` 同步 await、完整 payload、抛错使 ask 失败、有副作用工具 **write-ahead**（intent→result）（C-B3/M2′）；④ **无 finalize 的 ask 判 insufficient、raw text 不入库**（C-B2）；⑤ 子 agent 独立 ledger + merge_evidence、数量/深度上限（C-Major）；⑥ `cite` 只接受本会话 `search_chunks` 命中过的 chunk_id（M1）；⑦ 同名冲突抛错、不传同现状（既有 424 全绿）。
- **C-B1 相关必测**：⑧ P3.A 断言 agent 工具集**不含 bash/write/edit**（只读服务工具，无任意写攻击面）；⑨ chunk 只经服务工具内存返回（hash 校验），不经文件系统暴露给 agent；⑩ 审计外部锚定：整体重写审计文件后锚点比对能发现（`verify()` 单独不够）。**（P3.0-iso 才测）** ⑫ bash 降权子进程对 cases/audit 不可读写——OS 隔离冒烟。
- **context 预算必测（C-Major）**：⑪ 长文档专题下 agent 循环 token 不超 `CTX_BUDGET`（read_chunk cap + 历史摘要生效）。
- **质量与功能回归（评审 M4）**：① scripted model adapter 做确定性多轮回归（不依赖真模型）；② 本地模型冒烟须见 tool-calling **真实触发**（功能性，非仅质量）；③ 建小评测集（"问题→应引用 chunk"对）防召回/接地退化，定通过门槛。mock 多模态无语义，质量评测留 P3.D。
- 保持 `npm run check` 绿；新增只增不减既有 424。
- 每个"做实"里程碑做一次端到端冒烟：建专题→汇入→（按需）加工→agent 问答带溯源→审计 verify。

---

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| **bash/agent 改审计·伪造溯源·跨专题读（C-B1）** | **按需最小隔离（v2.5）**：P3.A 不给 bash/write/edit → 攻击面不存在、进程内安全；P3.B+ 引入 bash 时只把该工具降权子进程执行（OS 用户≠server、碰不到 cases/audit）+ 审计外部锚定（§4.4 / P3.0-iso）。不预先搬进程（避免过度工程） |
| **v2.4 全 worker+IPC 过度工程（第四轮两家）** | core 无 RPC 层，搬进程要重造 IPC + session 归属 + skill 加载 + worker 生命周期（被低估）；改为按需最小隔离，复杂度推迟到真给 bash 那一刻 |
| bash 外发 | 气隙网络隔离为主（不通外网）；降权子进程网络可再收紧；OfflineGuard 做 server 侧模型/slot 调用授权审计 |
| 专网内横向 | 部署方网络层（专网防火墙）解决 |
| **agent 自由文本答案夹带未 cite 断言（C-B2）** | 强制 `finalize_answer({claims})`，Inquiry 只从 finalize+ledger 生成，raw text 不入库，无 finalize 判 insufficient |
| **有副作用工具与审计非原子（C-B3）** | 工具中间件 write-ahead（intent→result）；P3.A worker 内先只放只读服务工具；超时确认/终止 |
| **并发 ask 经 agent 级注册表串线（C-B4）** | run/会话级注入或每 ask 独立 worker；测试断言不串线 |
| **长文档撑爆本地模型上下文（C-Major）** | search 默认回 snippet+id、read_chunk byte/token cap、历史滚动摘要、硬性 CTX_BUDGET |
| agent 循环非确定性、调用次数多 | 红线靠工具契约（不靠输出 schema），不限 agent；建评测集回归质量；`maxTurns` 上限防失控 |
| **本地小模型可能驱动不了 tool-calling（评审 M4 功能性风险，非仅延迟）** | A 期冒烟必须先验工具被真实调用；驱动不了则放宽 `strict` 或退回 single 模式；选模型时优先 function-calling 强的本地模型 |
| 本地模型延迟/吞吐拖垮 agent 循环体验 | A 期即换本地小模型实测；**定 ask 端到端延迟上限作验收硬指标**（评审 N5：多轮 × 全上下文会放大 token，需量化预算）；必要时缓存/降并发 |
| `cite` 凭空引用未检索内容 | 台账只接受本会话 `search_chunks` 返回过的 chunk_id；hash 校验双保险 |
| guard 接线遗漏致某条模型调用绕过零外发 | 用 adapter 装饰器**统一**包裹，而非每个调用点手写 authorize；测试覆盖 |
| journal 与审计链双写不一致 | 工具中间件同步 await（M2′），同一 await 链，append 抛错使 ask 失败；不走 EventBus 旁路 |
| 多 agent 失控（子 agent 递归派生） | 子 agent 深度/数量硬上限；spawn 工具计数 |
| core 改动破坏既有 424 测试 | P3.0 默认行为与现状完全一致（不传 extraTools 即原样）；隔离/注入仅在 server 侧用 |
| 旧 `generateJson` 路径与 agent 路行为分叉 | env 开关并存、A 期对比验收后再切主；不立即删 |
| 提示词 skill 化后 agent 不激活/激活错 | skill 描述质量 + 自检；保留默认系统提示兜底 |

---

## 8. 建议执行顺序

```
P3.0  run级注入 + 中间件 + finalize 契约
                              （core 进程内小改，默认行为不变、424 不破，阻塞后续，先做）
P3.A  问答接进 harness         （进程内 + 只读服务工具，证明范式垂直切片 + 本地 LLM 切换 + context 预算）
P3.B-stream  core stream() + 事件协议  （独立子里程碑，最重单项，UI 前置）
P3.B  skill=提示词 + 按需多模态 + 流式 UI （老师 #4：提示词/skill 管理 + 对话式 UI）
   └─ P3.0-iso（按需）：若 P3.B 给 agent bash/write，先做 bash 降权子进程隔离
P3.C  多 agent 编排            （老师 #3；待 ledger merge + 审计事件模型稳定后做）
──────── 以上本地文本 LLM + mock 多模态可全跑通、门禁绿 ────────
P3.D  真实本地多模态模型 + 评测 （原 P2.6，待部署）
```
> 第四轮两家收敛：P3.0 只做进程内三契约（finalize/run级注入/write-ahead），P3.A 进程内只读问答即可守住三红线；进程隔离推迟到真给 agent bash 的那一刻，且只隔离 bash 工具。避免为未来需求提前付费（CLAUDE.md §2）。

每步遵循既有节奏：**实现 → npm run check 绿 → 端到端冒烟 → 提交 → 子代理审核**。

---

## 9. 对照老师四条建议

| 老师建议 | 本计划落点 |
| --- | --- |
| 1. 数据管理（接入/输出）+ 角色管理 | 一期已做实（角色+密级强）；本计划不退化，数据批量导入/导出可作 P3.B/独立小项补强 |
| 2. 本地化模型部署并调用 | P3.A 切本地文本 LLM（纯配置）；P3.D 真实本地多模态 |
| 3. 多 agent 调用 | P3.C `spawn_subagent` + 编排器/子 agent |
| 4. 提示词管理 + skills 管理 + agent 基本要素 + 主流对话 UI | P3.B：提示词 skill 化 + 后台 skill 管理 + core stream + 流式会话面；agent 基本要素 core 已具备，本计划把它接进产品 |
