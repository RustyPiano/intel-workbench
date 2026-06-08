# 一期工程实现方案：情报分析工作台

> 本文把 [产品设计 + 界面规格](./intel-workbench-product-spec.md) 落成可执行的工程方案：
> 定架构、定仓库结构、定复用/改造映射、定数据底座与 API、定红线落点、定里程碑与验收。
> **本文供评审，评审通过后再动代码。** 产品方向与逐屏结构以产品 spec 为准，本文不改它。
> 配套：运行时见 [runtime-architecture](../explanation/runtime-architecture.md)。

---

## 1. 目标与范围（一期）

### 1.1 一期目标

按已锁定的"横向先搭骨架"打法，一期产出**一个可运行的本地 Web 应用**，达成：

1. **界面横向打通**：§8 的全部屏（首页 / 新建 / 工作台五 tab / 汇入 / 管理后台五模块）都可进入、可导航，真数据与占位混合。
2. **跨切面红线落实**：零外发、审计哈希链、溯源 Citation、报告复核闸门、开发模式标记——这几条**不随骨架降级**，凡接通的功能必须遵守（§7）。
3. **核心数据底座做实**：专题（Case）CRUD、统一落盘、最小审计链。
4. **一条真实 AI 主链**：文档专题的"问答带溯源"接通开发期文本 LLM 端点，验证溯源契约真的跑得通。

### 1.2 已锁定决策（评审输入）

| 项 | 决策 |
| --- | --- |
| 产品外壳 | 本地 Web 应用：Node 后端（复用现有运行时）+ 浏览器前端，跑 localhost；后期可套壳分发 |
| 一期打法 | 横向先搭所有界面骨架，再逐屏填实 |
| 开发期模型 | 先接 OpenAI 兼容**文本 LLM** 端点；ASR/VLM 按"该能力暂不可用"降级（产品 spec §10） |
| 下一步交付 | 先出本方案评审，通过后编码 |

补充默认（§2.2、§4.2 展开，评审时可推翻）：前端 React + Vite + TS；持久化一期走**文件优先、零新增依赖**（JSONL/JSON），Case 产物与审计链均落文件，SQLite 作为后续可选升级（§4.2）；一期最简本地账号 + 三角色。

### 1.3 一期验收红线（对应产品 spec §16.6）

四条硬准入，按"是否随骨架降级"分两类：

- **基础设施级（一期第一天就在，永远不降级）**
  - 默认无外发：应用自身全部出站经 `OfflineGuard`（白名单 + 审计），生产置空即一键禁断；OS/工具级出网由气隙部署承担（§7.1）。
  - 审计链可校验：关键动作落 append-only 哈希链，可独立校验（§7.2）。
- **功能级（凡该功能在一期接通，就必须满足；未接通的屏以占位/降级呈现）**
  - 所有结论有 citation：问答/要素/报告里凡是 AI 产出，必须挂 Citation；无 citation 只能作"待核提示"（§7.3）。
  - 报告未复核不可导出：报告走状态机闸门，未复核态 export 接口直接拒绝（§7.4）。

### 1.4 一期不做（降级 / 占位，对应产品 spec §13.5、§14）

媒体真实链路（ASR/VLM，降级为"暂不可用"）、算力档位切换（先单一配置）、提示词版本编辑（先内置基线只读）、Skill 离线导入（先固定内置）、报告多级会签（先单级）、复杂关系图谱（先列表 + 简单连线）、跨专题检索（专题内为界）。

---

## 2. 总体架构

### 2.1 分层

```
┌──────────────────────────────────────────────────────────────┐
│  web（新增）  React + Vite + TS                                │
│   作业面（专题工作台）  ·  管理面（管理后台）  ·  审计中心      │
│   顶栏：密级徽标 / ● 离线 / 开发模式徽标（常驻）                │
└───────────────▲──────────────────────────────────────────────┘
                │  HTTP / JSON（仅 localhost）
┌───────────────┴──────────────────────────────────────────────┐
│  server（新增）  Node + TS                                     │
│   ┌─ API 层（REST，鉴权，密级校验）                            │
│   ┌─ 用例服务：Case / Material / Inquiry / Report / Admin      │
│   ┌─ 横切：AuditService（哈希链）· CitationService · OfflineGuard│
└───────────────▲──────────────────────────────────────────────┘
                │  程序化调用（不经网络）
┌───────────────┴──────────────────────────────────────────────┐
│  runtime 内核（复用现有 src/）                                 │
│   RuntimeAgent / Conversation · ModelAdapter(openai-compatible)│
│   ToolRegistry · SkillRegistry · SessionStore · Policy         │
└───────────────▲──────────────────────────────────────────────┘
                │
        本地落盘：cases/<id>/（文件） + 全局 users.json · audit/audit.jsonl（文件）
```

要点：server **不重写运行时**，而是把 `RuntimeAgent` 当成一个进程内库来驱动（`createConversation`/`send`）。AI 能力沿现有模型适配器走，server 只在外面加用例编排、持久化、鉴权与红线。**问答不走开放工具循环**，而是 §7.3 的受控"检索→结构化生成→校验"管线（直接经模型适配器做结构化调用）；RuntimeAgent 的开放工具循环留给其余确需工具的流程。

### 2.2 仓库结构

在现仓库内拆 workspaces，不另起仓库：

```
mini-agent/
  packages/
    core/        ← runtime / model / tools / skills，对外导出 RuntimeAgent 等（**M0 暂保留在根目录，此为后续目标位**）
    server/      ← 新增：HTTP API + 用例服务 + AuditService + 持久化
    web/         ← 新增：React + Vite 前端
  .agents/skills/   ← 现有 skill 资产（被 core 发现、被 server 的管理后台接管）
  cases/            ← 运行期专题数据（落盘，gitignore）
  docs/
```

> **M0 的迁移策略（降风险）**：现有 `src/`、`tests/`、根 `package.json` 暂不物理搬动——根目录同时充当 workspace 根与 `core` 包，保持现有 42 个测试、`npm pack` 发布清单、CLI bin 全部不变、绿测不破。M0 只新增 `packages/server`、`packages/web` 两个 workspace，并给根包加最小 `exports` 入口供 server 复用 `RuntimeAgent`。把 `src/` 物理迁入 `packages/core/` 是纯结构调整、对功能无影响，**单独留一步**（带自己的绿测门）择机做，不拖累一期可见进度。

### 2.3 进程与端口

单 Node 进程对外暴露一个 localhost HTTP 端口：API 路由 + 生产构建时托管 web 静态产物（开发期 web 用 Vite dev server，API 走代理）。默认只绑 `127.0.0.1`，不监听外部网卡。

### 2.4 离线 / 零外发的工程落点

- **应用层**：应用全部出站经 `OfflineGuard`（白名单 + 审计），开发期白名单仅文本 LLM 端点，生产置空即断；该出站集中在模型适配器一处（§7.1）。
- **运行时层**：保留 `bash` 等工具——气隙环境无网可达，OS/工具级出网风险由部署层而非裁剪工具来消除；仅媒体云路径（豆包/DashScope/TOS）隔离到"开发模式"，因其指向商业/云服务，与开源约束冲突、不应进生产链路（§3、§7.5）。
- **部署层（部署要求，本文不实现）**：生产由基础设施默认拒绝出网；应用侧"● 离线"徽标与"外发拦截"审计事件给出可见信号。

---

## 3. 复用与改造映射（对真实文件）

| 现有文件 / 模块 | 一期处置 | 说明 |
| --- | --- | --- |
| `src/runtime/agent.ts`（RuntimeAgent / Conversation） | **直接复用** | server 的对话内核；`create→createConversation→send`（问答另走 §7.3 受控管线） |
| `src/runtime/session.ts` · `run-store.ts` · `trace.ts` | **复用** | 会话/运行/trace；trace 仅作审计补充证据，不替代 AuditEvent（§7.2） |
| `src/runtime/policy.ts` | **复用并加强** | workspace 沙箱收紧为"当前 Case 目录"边界 |
| `src/tools/file-mutation-queue.ts` | **复用（扩用）** | 审计 append 的单写者串行也复用此思路（§7.2） |
| `src/model/factory.ts` · `openai-compatible.ts` · `types.ts` | **复用** | 文本 LLM 走这里；开发期唯一白名单出站，经 `OfflineGuard` |
| `src/model/asr.ts`（豆包） · `multimodal.ts`（DashScope） · `tos-storage.ts`（火山 TOS / AWS S3 SDK） | **隔离到开发模式** | 默认不接；一期媒体降级；正式链路待替换为开源/本地 |
| `src/tools/analyze-audio.ts` · `analyze-media.ts` · `probe-media.ts` | **隔离到开发模式** | 出网集中在这三件套；产品默认工具集不含 |
| `src/tools/bash.ts` | **复用** | 保留；OS 级出网风险由气隙部署消除，不靠裁剪工具（§7.1） |
| `src/tools/{read,write,edit}.ts` | **复用** | 受 policy 限制在 Case 目录内 |
| `src/tools/activate-skill.ts` · `src/skills/*` | **复用** | 接 §8.12 Skill 管理后台（一期：列表 + 启停 + 自检，只读为主） |
| `.agents/skills/intel-bulletin` | **复用脚本，绕过 task CRUD** | 直接调 `render_report.py` 渲染 `cases/<id>/report/bulletin.spec.json`（脚本本就接受 `spec路径 + 输出路径`，与 `tasks/<id>` 无耦合）；`ingest.py` 复用做文档归一化；**不调** `manage_task.py`（其 `tasks/<id>` 布局不对用户暴露，产品 spec §13.4）。Case 适配＝server 侧"写 spec + 调脚本"一层薄封装 |
| `.agents/skills/av-dialogue-insight` | **一期降级** | 媒体链路；门槛达成前不进默认链路（产品 spec §13.1） |
| `.agents/skills/volcengine-media-setup` | **仅开发模式** | 正式链路不用 |
| `src/runtime/config.ts` 的 `asr*` / `mm*` / `tos*` 字段 | **收拢为"开发模式"配置块** | 正式默认空；与文本 LLM 主连接分离（现已分离，顺势归类） |
| `src/cli/doctor.ts` | **复用** | 接 §8.13 模型"自检"按钮 |
| `src/cli/*` 其余 | **保留** | CLI 作为 core 的命令行入口不破坏 |

---

## 4. 数据底座与持久化

### 4.1 Case 落盘布局（落实产品 spec §5.3）

```
cases/<case-id>/
  materials/        原始素材（汇入时拷入）
  processed/        每素材一份：归一化文本 / 切块(.chunks.jsonl) / 转写 / OCR / 译文
  elements.json     要素 / 关系 / 时间线（一期：文档抽取，最小可用）
  inquiries.jsonl   问答记录（含 Citation 引用）
  report/           报告 spec（bulletin.spec.json）+ 渲染产物（.md，可选 .docx）
  manifest.json     专题元数据 + 素材清单 + 加工状态
  audit.log         本专题哈希链（全局汇总在 audit/audit.jsonl，§4.2）
```

`tasks/<id>/`、`av-tasks/<id>/` 仅作迁移输入，不对用户暴露（产品 spec §13.4）。

### 4.2 持久化（文件优先，零新增依赖）

一期不引入数据库依赖：数据量是演示/小队规模，且现有运行时已用 JSONL 落盘（会话），延续同一风格最省心、也真正"零依赖"。

- **权威 = 文件**。Case 产物以 `cases/<id>/` 下文件为权威。
- **全局文件**（工作区根）：
  - `config/users.json` —— 用户/角色/可访问密级/口令哈希/启停。
  - `audit/audit.jsonl` —— 全局 append-only 哈希链审计，**权威**；专题内 `audit.log` 为本地筛选副本。
  - `cases` 列表、`materials` 列表 —— 由扫描 `cases/*/manifest.json` 派生；如需提速，缓存到可重建的 `.cache/index.json`（缓存非权威，可随时重建）。
- **嵌入检索**：二期再做（向量库）；一期问答的检索用关键词/全文 BM25 类兜底（§7.3）。

字段（产品视角，编码阶段补 Zod schema）：

| 存储 | 关键字段 |
| --- | --- |
| `config/users.json` | id, name, role(作业员/管理员/保密员), clearance(密级), pwd_hash, enabled |
| `audit/audit.jsonl`（每行一事件） | id, ts, user, action, object, result, **payload_hash, prev_hash, event_hash**（§7.2） |
| `cases/<id>/manifest.json` | id, name, clearance, status, owner, created_at, updated_at, materials[] |

> **后续升级路径（非一期）**：若跨专题查询/审计量增大到文件扫描吃力，再引入 SQLite —— 选型 `better-sqlite3`（原生模块，需为目标架构备好预编译二进制以适配离线安装）或 Node ≥ 22 的内置 `node:sqlite`（需相应抬升 `package.json` 的 `engines`，当前为 `>=20`）。一期不做。

### 4.3 Citation 契约（共享类型，落实产品 spec §13.2）

定义在 `core`（或 server 共享类型），被问答、要素、报告共同引用：

```ts
interface Citation {
  material_id: string;
  material_name: string;
  modality: "doc" | "audio" | "video" | "image";
  locator: { page?: number; paragraph?: number; timecode?: string; bbox?: [number, number, number, number] };
  snippet: string;
  derived_from?: Citation[];
  confidence: number;      // 0–1
  content_hash: string;    // 指向素材内容；素材变更则引用失效告警（≠ 审计的 event_hash，§7.2）
}
```

校验规则：任何写入 `inquiries.jsonl` / `elements.json` / 报告结论的 AI 产出，必须带至少一条有效 Citation，否则降级为"待核提示"，不得作为事实或写入报告（§7.3）。

### 4.4 其余 schema

`manifest.json`、`elements.json`、`inquiries.jsonl` 的字段以产品 spec §5.2 为准，编码阶段补 Zod schema（与现有 `core` 的 zod 用法一致）。

---

## 5. 后端 API 草案（REST，localhost）

标注：**实**=一期做实；**占**=占位/只读/降级。

```
POST   /api/auth/login                登录，返回会话与角色/密级           实
GET    /api/cases                     专题列表（按密级过滤）              实
POST   /api/cases                     新建专题                            实
GET    /api/cases/:id                 专题详情（manifest）                实
PATCH  /api/cases/:id                 重命名/归档（按权限）               实
POST   /api/cases/:id/materials       汇入素材（多文件）                  实(文档) / 占(媒体降级)
GET    /api/cases/:id/materials       素材列表 + 加工状态                 实
GET    /api/materials/:mid            素材内容（原文/转写/译文/OCR）      实(文档) / 占(媒体)
POST   /api/cases/:id/inquiries       问答 → 检索+结构化生成+校验管线（§7.3）   实
GET    /api/cases/:id/inquiries       问答记录                            实
GET    /api/cases/:id/elements        要素/关系/时间线                    占(文档最小抽取)
POST   /api/cases/:id/report/draft    生成报告草稿（调 intel-bulletin 渲染脚本，§3） 实
POST   /api/cases/:id/report/submit   提交复核                            实
POST   /api/cases/:id/report/approve  复核核准（保密员/管理员）           实
POST   /api/cases/:id/report/export   导出（未复核态拒绝）                实(闸门)
GET    /api/admin/prompts             提示词模板（内置基线只读）          占
GET    /api/admin/skills              Skill 列表 + 启停 + 自检            实(只读为主)
GET    /api/admin/models              模型配置 + 自检（doctor）           实
GET    /api/admin/users               用户管理                            实(最简)
GET    /api/audit                     全量审计（筛选）                    实
GET    /api/audit/verify              哈希链完整性校验                    实(红线)
POST   /api/audit/export              导出留存（导出本身入审计）          实
```

**写操作的提交与失败策略**（文件 + 审计非单一事务，须明确）：
顺序为 **先落业务产物（文件）→ 再 append AuditEvent**，审计 append 视为该操作的"提交点"。

- (a) 业务写成功但审计 append 失败 → 接口返回失败、**不向用户报成功**，并由启动时的"对账扫描"标记"有产物缺审计"的孤儿，供保密员处置。
- (b) 审计为 **append-only 单写者串行**（复用 file-mutation-queue 思路），避免并发把链写乱。
- (c) 除 `verify`（校验链完整性）外，另有"对账"——比对 cases 产物与审计事件的对应关系，列出缺口。

---

## 6. 前端结构

- **路由对应 §8**：`/login`、`/`（首页）、`/cases/new`、`/cases/:id`（工作台，子 tab：materials/elements/inquiry/report/audit）、`/admin/*`（prompts/skills/models/users）、`/audit`（审计中心）。
- **双面分离**：作业面与管理面用不同布局壳；管理入口仅管理员可见（§3 角色）。
- **常驻外壳**（产品 spec §7）：顶栏密级徽标 + `● 离线` + **开发模式徽标**（开发期高亮）+ 用户菜单。
- **占位策略**（产品 spec §10）：未接通能力统一走"该能力暂不可用 / 待加工 / 空态"组件，不假装成功；媒体素材显示降级提示。
- **溯源交互**：问答/要素/报告里的 Citation 可点击跳源并高亮（§9.4 双向跳转一期先做问答→素材方向）。

---

## 7. 跨切面红线的工程实现

### 7.1 零外发（分层，且明确各层可验证的边界）

零外发由两层共同保证，职责不混、可验收范围讲清：

- **应用层（本文实现、可审计、可验收）**：应用自身全部出站统一经 `OfflineGuard` 客户端发起——除"已配置模型端点"白名单外一律拒绝，每次放行/拒绝都落审计。开发期唯一白名单是文本 LLM 端点；生产环境把 `OfflineGuard` 白名单置空即一键禁断。媒体云工具（§3）仅开发模式可用，不进生产链路。
- **部署层（部署要求，本文不实现）**：气隙环境（机器物理无网）封堵 `bash`、子进程、第三方库等 OS/工具级出网。**应用不承诺能观测到这一层的外发**——这正是为什么边界必须由基础设施强制（与"安全边界不依赖软件自觉"一致）。
- 信号可见：`● 离线` 徽标常驻；`OfflineGuard` 拦截的**应用级**外发尝试落"外发拦截"审计事件并在审计中心高亮（产品 spec §8.15）。

### 7.2 审计哈希链（AuditEvent）

- **独立于运行时 trace**（产品 spec §13.3）：trace 面向调试，AuditEvent 面向保密复核。
- 字段：`payload_hash = H(规范化事件内容)`、`event_hash = H(payload_hash + prev_hash)`；append-only、单写者串行、不可改删。**命名上与 Citation 的 `content_hash`（指向素材内容）刻意区分，避免混用。**
- `GET /api/audit/verify` 重算全链，返回"链未断 / 断链位置"。
- 写入点（至少）：登录、汇入、加工、校对、问答、报告 生成/提交/复核/导出、配置变更、外发拦截。
- 落点：全局 `audit/audit.jsonl`（append-only，权威）+ 专题 `audit.log`（本地副本）。

### 7.3 溯源 Citation：检索→结构化生成→校验管线

仅"有引用"不够，须把每条结论绑定到被检索出的素材片段，并在无支撑时拒答。问答不走开放工具循环，而是一条受控管线：

1. **切块（汇入时）**：文档归一化后切成带稳定 ID 的 chunk（`<material_id>#<chunk_idx>`），记 `{chunk_id, material_id, locator(page/paragraph), text, content_hash}`，存 `processed/<material>.chunks.jsonl`。
2. **检索**：对问题取 top-k chunk（一期关键词/全文 BM25 类；嵌入检索二期）。无命中 → 直接返回"现有材料不足以判断"，不调用模型。
3. **结构化生成**：把编号 chunk 作为唯一可引用上下文喂给文本 LLM，要求按固定 JSON schema 输出：

   ```jsonc
   {
     "claims": [
       { "text": "...", "type": "fact|inference", "citations": ["<chunk_id>", "..."] }
     ],
     "insufficient": false
   }
   ```

   提示约束：每条 claim 必须引用给定的 `chunk_id`；无法被给定 chunk 支撑则置 `insufficient: true`。
4. **校验（CitationService）**：逐条 claim 检查——引用的 `chunk_id` 必须存在于本次检索结果、且其 `content_hash` 与当前素材一致；据此把 chunk 映射为对外 Citation（§4.3）。校验不通过的 claim 降级为"待核提示"，不得作为事实或写入报告（产品 spec §8.7、§9.5）。`insufficient: true` 或全部 claim 失败 → 回"现有材料不足以判断"。
5. **落盘**：问答与其 claims/citations 落 `inquiries.jsonl`。

> **诚实边界**：该管线把每条结论**绑定到被检索出的来源片段**并结构化拒答，消除的是"凭空捏造 / 无出处"；它**不证明逻辑蕴含**（结论是否真被引用支撑），后者由人在环路复核兜底（产品 spec §9.3）。

### 7.4 报告复核闸门

- 状态机：`草稿 → 待复核 → 已复核 → 已导出`；`export` 仅在 `已复核` 后放行，其余状态接口直接拒绝并记审计。
- 复核人 ≠ 起草人（一期可放宽为同人但记录，二期强制分离 / 多级会签）。

### 7.5 开发模式标记

- 配置项 `devMode: true` 时：顶栏与模型配置页显式高亮"开发模式"；允许走云端开源 LLM 替身。
- **硬约束**：`devMode` 下**禁止创建/进入涉密密级专题**（密级高于"内部"时拒绝），防止开发替身接触涉密数据（产品 spec §13.1）。

---

## 8. 里程碑与拆解（breadth-first）

| 里程碑 | 做实 | 占位 / 降级 |
| --- | --- | --- |
| **M0 脚手架** | workspace 起（根=core + 新增 server/web）+ **M0 门（§9）**、server 起 localhost、web 起、登录壳、顶栏三徽标、全路由可进入 | 各页内容先空态 |
| **M1 数据底座** | Case CRUD、落盘布局、文件持久化、**审计链 + verify + 对账** | —— |
| **M2 汇入与加工** | 文档汇入、归一化、**切块（chunk_id + content_hash）**、加工状态机、素材列表/阅读 | 媒体素材"暂不可用"降级；OCR/转写占位 |
| **M3 问答带溯源** | 文档检索→结构化生成→**Citation 校验**管线（§7.3）、问答记录落盘 | 嵌入检索→关键词/全文 BM25 兜底；要素抽取最小可用 |
| **M4 报告** | 草稿生成（调 intel-bulletin 渲染脚本）、编辑、**复核闸门 + 导出** | .docx 可选；多级会签不做 |
| **M5 管理后台骨架** | Skill 列表/启停/自检、模型配置/自检、用户最简、审计中心（筛选/校验/导出） | 提示词模板只读、Skill 导入不做、档位切换不做 |

> 与产品 spec §13.5 的"做实 vs 占位"对照一致；红线（§7.1/§7.2）在 M0–M1 即落地，不等后续里程碑。

---

## 9. 一期验收（Definition of Done）

**M0 门（先过再往功能里走）**
- 根 `npm run check`（typecheck + 全部 42 测试，含 package-release）保持**全绿**；
- CLI 入口（`mini-agent` bin）仍可运行；
- 根 `package.json` 新增 `workspaces` 与最小 `exports`（供 server 复用 core），且 `npm pack` 发布清单不变（package-release 测试不破）；
- `packages/server`、`packages/web` 各自可独立 typecheck / build；server 仅绑 `127.0.0.1`、无任何对外网络调用。

**红线（可演示判据）**
1. 应用自身出站全部经 `OfflineGuard`：非白名单目标→被拒且落"外发拦截"审计；开发期白名单仅文本 LLM 端点，生产置空即全断。（OS/工具级出网由气隙部署承担，不在应用验收范围，仅作部署要求登记。）
2. `GET /api/audit/verify` 对真实操作链返回"链未断"；手工篡改一条→校验报断链位置。
3. 问答里每条结论都能点回素材出处；构造无依据的问题→系统回"现有材料不足以判断"，不臆造。
4. 报告未复核态点导出→被拒；走完复核→导出成功且导出动作入审计。

**横向**：§8 每屏可进入，未接通能力以空态/降级正确呈现，不报错、不假装成功。

**纵向最小**：能用一个文档专题走完"建专题 → 汇入文档 → 问答带溯源 → 报告草稿 → 复核 → 导出"。

---

## 10. 风险与开放问题

- **媒体降级 vs "溯源覆盖率 100%"目标**：一期仅文档模态达成端到端；音视频/图像溯源待开源媒体链路就位（产品 spec §13.1）。验收口径据此限定为"已接通模态"。
- **Citation 管线的诚实边界**：绑定来源 ≠ 证明蕴含（§7.3 末），复核闸门是兜底，不能因有 citation 就省略人工复核。
- **LLM 端点稳定性/超时**：开发期单端点；超时走产品 spec §10 降级，不阻塞界面。
- **持久化边界**：一期文件优先（JSONL/JSON），以"文件为权威"避免双写不一致；数据量增大后再引入 SQLite（§4.2 升级路径）作为索引层。
- 呼应产品 spec §16 未决项：算力档位硬件边界、跨专题检索归属、报告多级会签、关系图深度——均不阻塞一期。

---

## 11. 已确认输入与待补项

评审已确认（2026-06-04）：

- **密级分级**：内部 / 秘密 / 机密 / 绝密 四级；开发模式仅允许"内部"。
- **预置账号**：一期预置 1 管理员 + 1 作业员 + 1 保密员，三角色齐全，便于演示复核闸门与审计中心的角色分离（保密员只读审计 + 可复核）。
- **monorepo 迁移**：采用，将现 `src/` 迁入 `packages/core`（§2.2），过迁移门（§9）后再进功能开发。
- **持久化**：一期文件优先、零新增依赖；SQLite 为后续可选升级（§4.2）。
- **应用定名**：暂定"情报分析工作台"（顶栏显示名，可后续改）。
- **保留 `bash`**：不裁剪工具，应用级外发由 `OfflineGuard` 收口、OS 级由气隙部署保证（§7.1）。

待补（不阻塞 M0–M2）：

- **文本 LLM 端点**（M3 前需要）：OpenAI 兼容的 `baseURL` + `apiKey` + 模型名（开源模型，非商业模型）。实现时通过环境变量或开发配置注入。
