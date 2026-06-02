# 大模型编程实践报告

**项目名称**：mini-agent —— 本地优先的智能体运行时及其两个交互式情报/音视频分析应用
**实践选题**：（1）文本情报整编类 ＋（2）音视频场景分析类 ＋（3）情感识别与对话分析
**运行时版本**：v1.1.0（Node ≥ 20，TypeScript strict）
**报告日期**：2026-06-02

---

## 摘要

本实践基于自研的本地优先智能体运行时 **mini-agent**，开发了两个由自然语言指令驱动的可交互智能应用：

1. **文本情报整编（intel-bulletin）** —— 对应选题（1）：把同一任务文件夹内的多份文档整编为符合公文规范的情报报文，并支持任务与源文件的增删改查。
2. **音视频对话综合分析（av-dialogue-insight）** —— 合并对应选题（2）与（3）：对会议/影视/对话类音视频做事件检测与时间定位、说话人分析、多模态情感识别、关键触发点解释与多模态总结，产出结构化报告。

两个应用均为 **Agent + Skill** 形态，构建在同一个文本智能体内核之上：用户下达自然语言指令，Agent 自主进行任务分解（planning）、在文本/多模态/语音三类能力间路由工具（tool routing）、处理失败与异常，并通过运行时自带的 run/session/trace 体系把整个执行过程沉淀为可审计的"过程文件"。

全部代码经 `npm run check`（类型检查 + 42 个测试文件、300 项测试）验证通过；两个应用均已用真实媒体与真实模型端到端跑通，详见第三章应用效果分析。

---

## 一、应用背景

### 1.1 项目概述

mini-agent 是一个**本地优先、模型可替换**的智能体运行时，提供：确定性的 Agent 主循环、可替换的模型适配器接口、内置工具（`read`/`write`/`edit`/`bash`/`activate_skill`）、技能（skill）发现与激活、JSONL 会话持久化，以及按运行（run）粒度的全量 trace 记录与时间线渲染。两个面向作业选题的应用以"技能 + 捆绑脚本"的方式构建于其上，runtime 内核保持纯文本，多模态能力以**专用工具**旁路接入（详见 §2.3）。

### 1.2 功能介绍

| 应用 | 对应选题 | 核心功能 | 交互方式 |
| --- | --- | --- | --- |
| **文本情报整编**<br>`intel-bulletin` | （1） | 任务/源文件 CRUD；多格式文档摄取（md/txt/docx/pdf）；要点与时间线提炼（事实与研判分离）；按公文规范渲染（标题/密级/主送/概要/分小节/结论/落款），可选导出 .docx | 「把 tasks/X 文件夹整编成情报通报」 |
| **音视频对话综合分析**<br>`av-dialogue-insight` | （2）＋（3） | 视频/图像理解（事件检测与 MM:SS 时间定位、多模态总结）；纯音频转写与说话人分离；多模态情感时间线；关键触发点解释；结构化报告渲染 | 「分析这段录音的事件、说话人与情感并出报告」 |

两应用共享同一交互范式：自然语言进、结构化报告与过程 trace 出，中间所有步骤由 Agent 自主编排。

### 1.3 应用场景

- **情报 / 舆情 / 公文整编**：把分散的简报、记录、纪要快速整编为规范报文，替代"人工读取—摘录—排版"。
- **会议 / 访谈 / 审讯 / 谈判复盘**：自动定位关键事件时点、刻画说话人、追踪情绪拐点并解释触发原因，为研判与复盘提供结构化、可定位的依据。
- **影视 / 监控片段理解**：在缺乏字幕或元数据时，从画面与声音中重建事件线与人物互动。

### 1.4 相关技术水平

- **多模态大模型**：2025–2026 年原生全模态模型（如 Qwen3.5-Omni、Gemini 3.x）已能直接对视频/音频/图像做时间定位与语义理解，且多数提供 OpenAI 兼容接口，可被现有工具链直接复用。
- **录音文件识别（ASR）**：火山引擎豆包录音 ASR 提供"标准版"（`volc.seedasr.auc`，submit→poll 异步，支持情感/性别/语速/音量等丰富元数据）与"极速版"（`volc.bigasr.auc_turbo`，一次性快转、说话人分离、本地内联）两档，覆盖从快速转写到富元数据分析的不同诉求。
- **智能体范式**：以"工具调用（function/tool calling）＋ 技能（skill）＋ 规划（planning）"为核心的 Agent 工程范式日趋成熟，强调把不确定的模型调用与确定的计算分离、把业务流程显式化。

本项目在以上技术现状之上，做的是**工程整合与方法落地**：用一个轻量、可观测、连接可替换的本地 runtime，把上述能力组织成两个端到端可用的应用。

### 1.5 创新点

1. **不侵入文本内核的多模态接入（B 方案）**：在纯文本 runtime 上，通过"把多模态模型调用封装为工具"引入音视频理解能力，`RuntimeMessage.content` 仍为字符串，会话/trace/系统提示体系零改动（见 §2.3）。
2. **选题（2）（3）合并为统一 pipeline**：事件定位、说话人、情感、触发点在一条可路由、可降级的流程中协同产出，而非拼接多个孤立工具。
3. **文本与音频走不同最优通道的 tool routing**：纯音频走 Doubao ASR（转写 + 富元数据），视频/图像走多模态 omni 模型，由 Agent 按"音频/视频 × 快速/富元数据"四象限显式选择引擎与接入方式。
4. **过程即产物（可观测性作为交付件）**：runtime 自带 run/session/trace，Agent 的规划与工具路由轨迹可直接导出为作业要求的"过程文件"，并支持 `doctor` 自检与失败归因。
5. **确定性下沉、不确定性收口**：解析、统计、校验、渲染等确定性环节下沉为可离线测试的 Python 脚本；模型调用等不确定环节集中在工具内并统一做异常/降级处理。

### 1.6 潜在应用价值

- **降本增效**：以 Agent 自动化替代重复性的"读—摘—排"和"逐帧看—记—标"劳动。
- **可控可审计**：本地优先、连接可替换（任意 OpenAI 兼容端点），过程全程留痕，适合在受控/涉密环境中部署与复核。
- **可扩展**：技能与工具解耦，新增分析维度或文档格式只需新增脚本/技能，无需改动内核。

---

## 二、大模型开发方案

### 2.1 开发遵循的标准与流程

- **规格先行（Spec Coding）**：先产出 `docs/specs/intel-bulletin-spec.md` 与 `docs/specs/av-dialogue-insight-spec.md`，明确数据模型、工具/脚本接口契约、Agent 工作流与**验收标准**，再实现。沿用内核既有的 spec/plan 文档传统（`docs/mini-agent-runtime-spec.md`、`docs/superpowers/plans/*`）。
- **文档体系（Diátaxis）**：按 tutorial / how-to / reference / explanation 四类组织（`docs/tutorials`、`docs/how-to`、`docs/reference`、`docs/explanation`），README 给出连接配置与媒体工具的最小化上手路径。
- **工程规范**：TypeScript strict；工具入参一律用 **zod** 校验并派生 OpenAI strict 模式可用的 JSON Schema；统一错误码（`RuntimeErrorCode`，如 `PATH_NOT_ALLOWED`/`SESSION_NOT_FOUND`/`RUN_NOT_FOUND`）；文件写入走原子写（tmp + rename）；trace 落盘前做密钥脱敏（Slack/GitHub/AWS 等模式 + 预签名 URL 红act）。
- **测试驱动 + 质量门禁**：每个脚本、工具、runtime 行为均配套单元/集成测试；`npm run check`（typecheck + 全量测试）作为合入门禁，当前 **42 个测试文件、300 项测试通过、2 项（需联网的烟雾测试）跳过**。
- **版本规范**：Conventional Commits（如 `feat`/`fix`/`docs`），改动配套测试与文档同步更新。

### 2.2 总体架构设计

```
                         自然语言指令
                              │
                              ▼
   ┌───────────────────────────────────────────────────────────┐
   │              Agent loop（纯文本，确定性主循环）              │
   │   provider: OpenAI 兼容适配器（DeepSeek / 通义 / GPT …）    │
   └───────────────────────────────────────────────────────────┘
        │ tool calling                         │ activate_skill
        ▼                                       ▼
  内置工具                               Skill 工作流（业务编排）
  read / write / edit / bash             ┌──────────────────────────────┐
  ──────────────────────────────        │ intel-bulletin（选题1）       │
  媒体工具（旁路多模态）                  │   ingest.py / manage_task.py  │
  probe_media  ── ffprobe                │   / render_report.py          │
  analyze_media ── callOmni ──► 多模态    ├──────────────────────────────┤
  analyze_audio ── ASR client ─► Doubao   │ av-dialogue-insight（选题2+3）│
                    (submit→poll)         │   audio_stats.py /            │
                                          │   validate_analysis.py /      │
                                          │   render_report.py            │
                                          └──────────────────────────────┘
        │
        ▼
  公文报文 / 音视频分析报告  ＋  run / session / trace（过程文件）
```

三层职责：**Agent 内核**负责规划与工具调用；**工具层**把不确定的模型调用与系统能力封装为带 schema 的可调用单元；**技能/脚本层**把业务流程显式化、把确定性计算下沉为可离线测试的脚本。

**三套独立连接**（互不回退，按需配置）：

| 通道 | 配置前缀 | 用途 | 本次验证所用 |
| --- | --- | --- | --- |
| 文本主模型 | `MINI_AGENT_*` | 驱动 Agent 主循环 | DeepSeek（OpenAI 兼容） |
| 多模态 | `MINI_AGENT_MM_*` | `analyze_media` 视频/图像 | Qwen3.5-Omni（DashScope） |
| 语音 ASR | `MINI_AGENT_ASR_*` | `analyze_audio` 纯音频 | 火山豆包录音 ASR |
| 对象存储（可选） | `MINI_AGENT_TOS_*` | 大文件 → 短时预签名 URL | 火山 TOS（S3 兼容 SDK） |

### 2.3 关键设计决策与合理性

**① 为什么是 Agent + Skill，而非一段固定脚本？**
作业要求"可交互"且覆盖 CRUD、规划、异常处理。Agent 负责理解意图与动态编排，Skill 负责把领域流程固化为可复用的工作流，二者解耦使同一内核可同时承载文本与音视频两类应用。

**② 多模态接入为什么选"专用工具"（B 方案）？**
候选有 A（纯脚本旁路）、B（专用工具）、C（runtime 原生多模态）。选 **B**：

- 直接命中 function calling / tool routing 考点——模型以"调用工具"的方式使用多模态能力；
- 不动文本内核——多模态 content parts 封装在 `src/model/multimodal.ts` 的 `callOmni` 内，会话/trace/提示体系无需改造；
- 复用现有 OpenAI 兼容适配器与连接机制，工程成本最低、可行性最高。

**③ 纯音频为什么走 Doubao ASR 而非 omni 模型？**
录音类对话的核心诉求是高质量转写、说话人分离与情感等富元数据。Doubao 录音 ASR 在中文转写与说话人/情感元数据上更专业，并提供两档引擎以匹配不同诉求：

| 引擎 | 资源 | 特点 | 适用 |
| --- | --- | --- | --- |
| `turbo` | `volc.bigasr.auc_turbo` | 一次性快转、说话人分离、本地内联（wav/mp3/ogg/opus，免 TOS）；不含情感/性别/语速/音量 | 快速转写优先 |
| `standard` | `volc.seedasr.auc` | submit→poll，格式更广、支持长/大音频、富元数据（情感/性别/语速/音量） | 富元数据或保留原格式 |

**④ 媒体接入的 inline / TOS 取舍**：本地文件 Base64 编码后小于 10MB（DashScope 限制）直接内联；超限文件经火山 TOS 私有桶上传后，用**短时预签名 URL** 交给模型。TOS 上传刻意采用 **AWS S3 兼容 SDK**（而非厂商 SDK）以规避有漏洞的依赖。预签名 URL 在 trace 中被红act，不落明文。

**⑤ 确定性下沉到脚本**：解析、统计、校验、渲染等下沉为 Python 脚本，既保证输出可复现，又能脱离模型做单元测试（见 §3）。

### 2.4 大模型编程工具的应用方法（怎样用大模型工具开发本项目）

本项目本身就是"用大模型编程工具开发智能应用"的实践，开发方法贯穿以下闭环：

1. **规格协同**：用大模型编程工具与人协作，先把每个应用的接口契约与验收标准写成 spec（`docs/specs/*`），把"做什么、怎么验收"前置固定，再让工具据此实现，减少返工。
2. **Prompt engineering 沉淀为技能**：把领域知识写进 `SKILL.md`（工作流）与 `references/`（`analysis-schema.md` 分析 JSON 模式、`writing-guide.md` 公文规范），使同一工具靠"分目的指令"完成事件/说话人/情感等不同子任务；技能描述（含中英文触发词）经 `evals/evals.json` 校准正/反例激活。
3. **Tool / function calling 实现**：把确定性能力封装为带 zod schema 的工具，`getToolJsonSchema` 派生 OpenAI strict 模式 JSON Schema，由模型按需调用；新增 `probe_media`/`analyze_media`/`analyze_audio` 三个媒体工具。
4. **测试驱动 + 工具辅助生成测试**：为脚本、工具、runtime 行为编写单元与集成测试（大模型工具协助生成与补全），以 `npm run check` 作为门禁。
5. **自举式端到端验证（dogfooding）**：用 mini-agent 自身以自然语言指令跑通两个应用，并把 `run show`/`session show --trace` 的轨迹作为过程证据；用大模型编程工具进行端到端测试、缺陷定位与修复——本次即通过这种方式发现并修复了 read-only 模式下 bash 绕过、`--session` 不能新建、`run show` 错误信息泄漏等问题（见 §3.5）。
6. **评审与重构**：用工具做 code review、安全审查与清理重构（例如移除早期已废弃的分片/经典管线/实验脚手架），保持实现与文档一致。

### 2.5 能力目标达成对照

| 能力目标 | 落地点 |
| --- | --- |
| 1.1 使用 LLM API / 本地模型 | OpenAI 兼容适配器驱动文本 loop；`callOmni` 调多模态模型；ASR 客户端调 Doubao |
| 1.2 prompt engineering | `SKILL.md` 工作流 + `references/analysis-schema.md`（分析模式）+ `writing-guide.md`（公文规范）+ 分目的指令 |
| 1.3 function / tool calling | zod schema → strict JSON Schema；内置工具 + `probe_media`/`analyze_media`/`analyze_audio` |
| 2.1 业务逻辑拆分 | 摄取/管理/渲染；探测/分析/统计/校验/渲染 分别成脚本与工具 |
| 2.2 封装基础能力为 tool/skill | 2 个 Skill + 3 个媒体工具 + 多模态 / ASR helper |
| 2.3 流程化处理 | `SKILL.md` 固化确定性工作流，脚本承担确定性计算 |
| 3.1 任务分解（planning） | 由 `probe_media` 时长/大小决定内联或走 URL；多步编排 |
| 3.2 多模态系统 | 视频/音频/图像 content parts；omni 模型 + 专用 ASR |
| 3.3 tool routing | 音频→`analyze_audio`、视频→`probe_media`+`analyze_media`；同一工具按目的路由不同指令 |
| 3.4 失败与异常处理 | 重试、降级（degraded）、缺流降级、超限转 URL、鉴权/超时友好报错、统一错误码 |
| 3.5 完整 pipeline | 文本：建任务→收录→摄取→起草→渲染→登记；音视频：probe→analyze→stats→validate→render |

---

## 三、应用效果分析

### 3.1 验证方法

效果验证分三个层次，全部可复现：

1. **自动化测试体系（系统性、回归性）**：42 个测试文件、300 项测试。其中
   - *脚本级确定性*：`intel-bulletin-scripts`、`av-dialogue-scripts` 验证 DOCX 标准库摄取、CRUD、`render_report`/`audio_stats`/`validate_analysis` 的确定性输出；
   - *端到端就绪*：`intel-bulletin-readiness`、`av-dialogue-readiness` 用脚本化模型把多源任务/媒体分析端到端整编出与 `fixtures/*/expected-report.md` **逐字一致**的报告；
   - *可观测性*：`runtime-observability` 验证成功/失败/中止三种结局分别落为 `completed`/`failed`/`cancelled` 并带错误归因；
   - *Agent 行为*：会话恢复、技能恢复、工具超时结构化返回、模型错误落盘等。
2. **真实案例（端到端、真模型真数据）**：用真实视频/音频与真实模型端到端跑通（见 §3.2–§3.3）。
3. **技能激活 eval 集**：每个技能的 `evals/evals.json` 定义正/反例与必含/禁含标记（如必须出现 `probe_media`/`analyze_media`，禁止"仅图片说明"误触发），由 `skill-evals` 校验模式。

### 3.2 应用一效果：文本情报整编

多源任务（md + txt）经 Agent「建任务 → `add-source` 收录 → `ingest.py` 摄取 → 提炼要点与时间线 → 起草 `bulletin.spec.json` → `render_report.py` 渲染 → `set-report` 登记」，整编出**确定性公文**，结构含 标题 / 密级 / 主送 / 概要 / 分小节（中文序号"一、二、…"）/ 结论 / 落款日期，与 `fixtures/intel-bulletin/expected-report.md` 逐字一致（`intel-bulletin-readiness.test.ts`）。

关键质量点（均有测试佐证）：

- **不臆造元数据**：来源未提供主送/密级/编号/落款时，按要求标注 `unknown/pending verification` 或留空，绝不编造（eval `intel-positive-uncertain-facts`，禁含"各相关部门""情报〔2026〕第000号"）。
- **CRUD 完备**：create/list/show/update/delete、add-source/remove-source，渲染后 manifest `status=rendered`、源计数正确。
- **多格式摄取**：DOCX 仅用标准库解压 `word/document.xml`；PDF 缺 `pypdf`/`pdfminer.six` 时**跳过并报告**而非崩溃。

### 3.3 应用二效果：音视频对话综合分析（真实案例）

以下三例均为本次用真实模型 + 真实媒体的端到端运行结果，可凭测试密钥与样例文件复现。

**案例 A —— 视频理解 + 事件时间定位（选题 2）**
输入一段 **6 分 37 秒、640×360、H.264+AAC、约 11.3 MB** 的视频。Agent 自主流程：`bash` 定位文件 → `probe_media` 取时长/分辨率 → 因 Base64 编码后超过 10MB 内联上限，**自动经火山 TOS 上传取短时预签名 URL** → `analyze_media` 交 Qwen3.5-Omni 分析。约 51 秒返回带 **MM:SS 时间戳的分镜事件线**（识别出 Synchron Stentrode 脑机接口纪录短片的人物、办公室讲解、血管介入动画、意念操作 iPad 等场景）。验证了 *视频内容理解 + 关键事件检测与时间定位 + 多模态总结* 与 *超限→TOS→URL* 的完整路由。

**案例 B —— 快速转写（turbo 引擎 + 格式自适配）**
输入 **4.5 MB 的 m4a** 录音并要求"快速转写"。Agent 识别出 m4a 不被 turbo 支持，**先用 `ffmpeg` 转为 16kHz 单声道 WAV**，再用 turbo 引擎转写、关闭说话人/情感以求快，并把完整结果写入 `out_path` 后读回。约 30 秒产出一段连贯的中文转写（低温液氮实验设备操作讲解）。验证了 *本地格式不兼容→ffmpeg 转码→turbo 内联* 的降级路径与 `out_path` 持久化。

**案例 C —— 富元数据情感/对话分析（standard 引擎，选题 3）**
对同一录音要求"识别说话人、每段情绪并总结情绪走向"。Agent 选择 **standard 引擎**，因本地文件而**经 TOS 上传**后调用 `volc.seedasr.auc`，返回**逐句情感**（neutral / happy / surprise）、**说话人分离**（主讲 Speaker 1 占绝大多数、Speaker 2 仅简短回应）与时长，并归纳出"平稳讲解 → 愉快分享 → 平稳答疑 → 末尾意外/困惑"的**情绪走向**。验证了 *说话人分析 + 多模态情感 + 关键触发点解释* 与"按目的在 turbo/standard 间路由"的设计。

> 说明：案例 B 与 C 同源不同引擎，恰好印证 §2.3 的引擎取舍——快速诉求用 turbo（无情感）、富元数据诉求用 standard（含情感，需 URL/TOS）。

### 3.4 方法对比与先进性

本方案与若干替代路线的对比（结合上文实测观察）：

| 维度 | 单一模型 + 人工拼接 | 纯云端黑盒工具 | 纯 ASR / 字幕方案 | **本方案（Agent+Skill）** |
| --- | --- | --- | --- | --- |
| 编排 | 人工 | 固定 | 固定 | **Agent 自动规划 + tool routing** |
| 覆盖维度 | 单一 | 取决于产品 | 仅转写 | **事件/说话人/情感/触发点四类协同** |
| 多模态情感 | 需另接 | 黑盒 | **缺失** | omni + Doubao 双通道 |
| 部署/可控 | — | 云端、不可审计 | — | **本地优先、连接可替换、过程可审计** |
| 失败处理 | 人工 | 黑盒 | — | **重试/降级/缺流降级显式固化** |

实测层面的"对比观察"：

- **omni vs 纯 ASR**：纯 ASR 路线（仅转写/说话人）在结构上**缺失多模态情感与触发点**；本方案以 standard 引擎补齐逐句情感（案例 C），并以 omni 补齐视频事件（案例 A），覆盖更完整。
- **turbo vs standard**：turbo 快但无情感元数据，standard 富元数据但需 URL/TOS——本方案按用户意图路由，兼顾速度与深度，而非二选一。
- **inline vs URL**：小文件内联省去上传与公网暴露，大文件经私有桶短时预签名 URL，兼顾效率与隐私（URL 在 trace 中红act）。

> 先进性边界（如实说明）：当前效果以**功能正确性 + 真实案例 + 确定性回归测试**为主要证据；尚未建立大样本基准（如帧级 DER、LLM-judge 评分、事件 F1 的统计显著性）。引入标注数据集与上述指标做规模化对比，是直接的增强方向（见 §五）。

### 3.5 鲁棒性与异常处理验证

本次还专门对边界与失败路径做了实测，进一步支撑"失败与异常处理"考点：

| 场景 | 期望 | 实测结果 |
| --- | --- | --- |
| 非法 API Key | 友好报错、密钥脱敏 | "Provider authentication failed"，密钥显示为 `****-key`，退出码 1 |
| 写敏感路径 `/etc/...` | 策略拒绝 | `PATH_NOT_ALLOWED`，并建议改写工作区内路径 |
| `--read-only` 下经 bash 重定向写文件 | 应被拦截 | 拦截"writes through output redirection"，文件未创建；只读命令（`ls`/`cat`/`grep`）仍可用 |
| 达到 `--max-turns` 上限 | 优雅交接 | 触发 `turn_limit_reached`，返回"回复继续/提高上限"的交接消息，run 正常 `completed` 可续 |
| `run show <不存在的id>` | 友好报错 | `Run not found: <id>`，退出码 1 |
| 跨进程会话续聊 | 记忆保持 | 同一 `--session` 在新进程中正确召回先前事实 |
| 非法 CLI 参数 | 非零退出 + 明确信息 | 未知 flag / 错误 `--trace` 枚举 / 非正 `--max-turns` 均退出码 2 并给出原因 |

> 其中 read-only/bash 拦截、`--session` 新建-或-续聊、`run show` 友好报错三项，是本次实践中通过"用大模型工具端到端测试 → 定位 → 修复 → 回归"闭环新增/修复的能力，并配套了单元测试。

---

## 四、复现实验

以下命令均可直接运行（媒体相关需先配置对应连接，参见 README 与 `doctor` 自检）：

```bash
# 0. 安装与质量门禁（typecheck + 全量测试）
npm install
npm run check

# 1. 连接自检：查看 [model_provider] / [multimodal_path] / [asr_path] / [tos_storage]
npm run dev -- doctor

# 2. 应用一：文本情报整编
npm run dev -- "把 tasks/<task-id> 文件夹里的文档整编成一份情报通报并渲染为公文"

# 3. 应用二：音视频对话综合分析（需配置 MINI_AGENT_MM_* / MINI_AGENT_ASR_*）
npm run dev -- "请分析 <媒体路径> 的事件、说话人与情感，并产出带时间戳的结构化报告"

# 4. 过程文件：导出某次运行的规划与工具调用轨迹
npm run dev -- run list
npm run dev -- run show <run-id> --format timeline   # 或 json / markdown
npm run dev -- session show <session-id> --trace

# 5. 脚本级确定性验证（可离线，不需模型）
python3 .agents/skills/intel-bulletin/scripts/render_report.py <spec.json> <out_base>
python3 .agents/skills/av-dialogue-insight/scripts/audio_stats.py <asr.json>
python3 .agents/skills/av-dialogue-insight/scripts/validate_analysis.py <analysis.json>
```

---

## 五、局限与展望

- **规模化评测**：引入标注数据集、LLM-judge、帧级 DER（pyannote `DiarizationErrorRate`）与事件 F1 的统计显著性，把"功能正确 + 案例"升级为"规模化基准对比"。
- **长视频处理**：更智能的分片与跨片说话人聚类，处理超长会议/影视。
- **版式精排**：公文与分析报告的 .docx/.pdf 版式精排；任务级 Web 可视化看板。
- **多语种与跨任务检索**：当前聚焦中文与单任务整编，可扩展多语种与跨任务知识检索。

---

## 六、交付物清单

- **源代码**：`src/`（runtime + 三个媒体工具 + 多模态/ASR/TOS helper）；两个 Skill（`.agents/skills/intel-bulletin`、`.agents/skills/av-dialogue-insight`）及配置助手 `volcengine-media-setup`。
- **过程文件**：`docs/specs/`（两份 spec，规格先行）、`docs/report/`（本报告）、运行时 `.mini-agent/runs|sessions`（run/session/trace JSONL，可经 `run show`/`session show --trace` 导出）。
- **测试与样例**：`tests/`（42 个测试文件、300 项测试）、`fixtures/`（两应用的期望报告与样例源文件）、各技能 `evals/evals.json`（激活与标记校验）。
- **文档**：README（连接与媒体工具上手）、`docs/`（tutorial / how-to / reference / explanation 四类）。
