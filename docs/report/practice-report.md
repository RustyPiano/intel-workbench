# 大模型编程实践报告

**项目名称**：离线情报分析工作台（intel-workbench）—— 面向涉密、气隙环境的本地优先多模态情报研判系统
**实践选题**：（1）文本情报整编 ＋（2）音视频场景分析 ＋（3）对话/说话人分析（统一收敛为一个工作台）
**技术栈**：TypeScript（strict）monorepo —— `packages/{core,server,web}`；Express + React/Vite；纯文件存储（无 DB，气隙友好）；vitest
**报告日期**：2026-06-22

---

## 摘要

本实践交付一个**离线优先、面向情报部门、可在气隙（air-gapped）环境部署**的多模态情报分析工作台。它把分散的多格式素材（文档 / 音频 / 视频 / 图像）摄入为带**逐字出处**的切块，提供混合检索、带溯源的问答、要素抽取，并在其上构建了两项**自研分析能力**——**交叉验证/矛盾检测**与**要素关系网络/时间线**，最终经复核闸门产出规范报文。整个系统在三条贯穿始终的**红线**约束下运行：

1. **零外发（zero-egress）**：任何出站模型调用前必须经 `OfflineGuard.authorize` 显式授权，气隙环境可整体拒绝；
2. **逐字引用（verbatim citation）**：引用 = 原文逐字片段，`content_hash = sha256(chunk.text)`，**绝不让 LLM 生成/改写的文本进入被引用内容**——这是结构性裁决（`resolveValidCitations`），而非提示词约束；
3. **哈希链审计（hash-chained audit）**：每个操作（含失败/降级/拒绝路径）追加进防篡改审计链。

与"套壳大模型直出"的根本区别在于：本项目的拿分点不是调用了多强的模型，而是**在情报域的硬约束（涉密、需复核、零外发）下，把不确定的模型调用与确定的可验证计算分离**，并用 **benchmark 量化证明自研分析 skill 相对大模型直出的不可替代价值**（详见第三章与 `docs/report/benchmark-summary.md`）。

全部代码经质量门禁 `npm run check`（类型检查 + **78 个测试文件、620 项测试通过、2 项需 TCP 的烟雾测试跳过**）验证；五个模型槽（OCR/ASR/Embed/Rerank/VLM）均已用真实模型端到端跑通。

---

## 一、应用背景

### 1.1 项目概述

intel-workbench 是一个**离线优先、模型可替换**的情报分析工作台，采用三层 monorepo：

| 包 | 角色 | 关键内容 |
| --- | --- | --- |
| `packages/core`（mini-agent） | 纯文本智能体运行时内核 | 确定性 Agent 主循环、OpenAI 兼容模型适配器、内置工具、流式、run/session/trace |
| `packages/server`（@intel-workbench/server） | 后端 | Express API、文件存储、摄入/检索/问答/分析/报告/审计/鉴权服务、五模型槽、OfflineGuard |
| `packages/web`（@intel-workbench/web） | 前端 | React + Vite 双面工作台（作业面 / 管理面） |

数据层刻意采用**纯文件"文件即库"**（无数据库）：每个专题（case）一个目录，含 `manifest.json`、切块 `*.chunks.jsonl`、向量 `.vec`、要素/矛盾 JSON、审计镜像与报告——便于在气隙单机上整体迁移、审计与离线复核。

### 1.2 功能介绍

| 模块 | 核心功能 |
| --- | --- |
| **素材摄入** | 文档（本地 `lit` 解析 PDF/Office→页级切块）、音频（本地 FunASR 转写+句级时间戳+说话人分离）、图像（VLM 画面描述 + 本地 PaddleOCR 文字）、视频（ffmpeg 场景分镜→逐镜头 VLM 描述+ASR+关键帧 OCR）——摄入即加工、失败优雅降级 |
| **混合检索** | token 预算路由（默认全上下文，超预算才检索）；BM25 ⊕ dense 向量 RRF 混合 + Qwen3-Reranker 重排；Contextual Retrieval / 查询改写 / HyDE 均 opt-in |
| **带溯源问答** | Agent harness 驱动（search/read/cite/finalize 四只读工具）、流式会话面、每条结论绑定可点击原文/音频片段/视频帧引用 |
| **要素抽取** | 人物/组织/地点/事件/装备/时间，每条"提及"指回真实切块（伪造出处即丢弃） |
| **★ 交叉验证/矛盾检测** | 跨文件「同事实异说」+ 文件内矛盾，原创锚定+成对 NLI 算法，逐条 provenance（自研，benchmark 见 §3） |
| **★ 要素关系网络/时间线** | 确定性共现图 + 时间线，可溯源、非 LLM 画图（自研） |
| **报告复核** | 草稿→待复核→已复核→已导出 状态机闸门，按公文规范渲染 |
| **审计中心 / 人工校对 / 跨专题总览** | 哈希链审计 verify/导出；低置信项「点此校对」；按密级裁剪的只读聚合面板 |
| **用户与权限** | 真用户系统（服务端会话 + scrypt + 令牌）、四级密级裁剪、双面分离（作业员/管理员） |

### 1.3 应用场景

- **涉密情报研判**：在气隙内网把多源涉密素材整编为带逐字出处、可复核的研判结论与报文，替代"人工读—摘—排"并满足审计要求。
- **交叉核验与矛盾发现**：对同一事实在不同来源/同一来源内部的冲突说法自动定位、并排呈证、逐条溯源——情报真伪研判的核心动作。
- **多模态线索整编**：会议/侦听录音（说话人+时间戳）、监控/影视片段（事件+画面）、扫描件（OCR）统一进入同一可检索、可引用的语料。

### 1.4 相关技术水平与本项目定位

- **多模态/检索增强**：2025–2026 年多模态大模型与 RAG 工程已成熟，多数提供 OpenAI 兼容接口。但**面向涉密/气隙场景的开源本地栈**仍是工程空白：云 API 不可用、模型须可替换为本地、过程须可审计。
- **本项目定位**：不追求"更大的模型"，而是在**离线、可审计、逐字溯源**的硬约束下，用可替换的本地模型栈（开发期以同协议云替身验证）组织出一条端到端可用、且**带原创分析能力**的工作台。创新与拿分点集中在：①三红线作为系统级不变量；②原创矛盾检测/关系网络 skill + benchmark；③气隙友好的全本地模型栈与"云替身"开发范式。

### 1.5 创新点（对齐"创新性"：做别人没做过的、设计可见、非套壳）

1. **三红线作为结构性不变量，而非提示词约束**。最关键的是"逐字引用"——把"绝不让模型生成/改写的文本进入引用"做成**唯一裁决点** `resolveValidCitations`：任何结论的引用必须命中真实切块的 `content_hash`，伪造/篡改的出处被丢弃。即便有人改写系统提示词也绕不过，因为裁决在 harness 层强制。这把"AI 会编造出处"这一公认风险，从"靠提示词请求模型别编"升级为"结构上不可能编"。
2. **原创交叉验证/矛盾检测算法（非"让 LLM 找矛盾"）**：锚定（逐块抽主张→真实切块接地）+ 确定性实体聚类 + **仅簇内成对 NLI** + 确定性置信度。配套自造标注语料与 benchmark，**量化对比大模型直出**，并诚实定位结构化的真实价值在 provenance/可扩展/可审计（§3.2）。
3. **要素关系网络/时间线 = 确定性共现聚合**：两要素同切块出现即连边（权=共现块数，边带逐字引用），时间线按确定性解析的时间锚排序，解析不出如实标"无明确时序"——**可溯源、可点跳源、不编造**，而非把素材丢给 LLM 让它"画"一张不可验证的图。
4. **气隙友好的全本地模型栈 + 云替身开发范式**：OCR=本地 PaddleOCR、ASR=本地 FunASR（句级时间戳+说话人）；Embed/Rerank/VLM 部署期换本地、开发期用同协议云替身验证真链路。出站点全部收敛到 OfflineGuard，气隙可一键拒绝。
5. **诚实负结果作为规范性证据**：检索增强（CR/改写/HyDE）在清洁合成基准上**不增益**——本项目如实报告并据此把三者设为 opt-in 默认关，而非粉饰（§3.1）。

### 1.6 潜在应用价值

- **可控可审计**：本地优先、连接可替换、过程全程留痕 + 防篡改审计链，适合受控/涉密环境部署与复核。
- **降本增效**：以自动化摄入/检索/交叉核验替代"逐份读—比对—摘录—排版"的重复劳动，且每条结论可一键溯源核验。
- **可扩展**：新增模态或分析维度只需接入对应模型槽或新增分析服务，下游检索/引用/审计零改动。

---

## 二、大模型开发方案

### 2.1 开发遵循的标准与流程（对齐"规范性"）

- **规格先行（Spec Coding）**：先产出 `docs/specs/intel-workbench-*` 规格（数据模型、服务契约、Agent 工作流、验收标准、红线不变量），再实现。
- **对抗式双评审编排**：每个特性由 **Codex（高推理强度）实现 → Codex 与 Opus 各自独立审核（双评审）→ 分歧深追裁决 → 本地 `npm run check` 作为真验收闸 → 决策日志留痕**。沙箱屏蔽 TCP 导致 server 网络测试假失败，故**恒以本地全量测试为准**，不轻信沙箱内的"测试通过"。
- **决策日志（过程可复述）**：`docs/report/rag-quality-decision-log.md` 逐步记录 D8–D19 每个特性的背景→根因/选项→决策→理由→验证→状态，**含诚实负结果**（检索增强不增益）与误报裁决（如矛盾检测评审中一处 MAJOR 经深追定为引用相等语义的误报）。
- **工程规范**：TypeScript strict；统一错误码与 `AppError`；文件写入原子化；审计 best-effort 不崩主流程；Conventional Commits，改动配套测试与文档同步。
- **质量门禁**：`npm run check` = typecheck + 全量测试，当前 **78 测试文件 / 620 通过 / 2 跳过**（跳过项为需 TCP 的烟雾测试）。

### 2.2 总体架构

```
                         自然语言指令 / 工作台操作
                                  │
   ┌──────────────────────────────────────────────────────────────────┐
   │  Web 双面（作业面 operator / 管理面 admin）  React + Vite         │
   └──────────────────────────────────────────────────────────────────┘
                                  │ HTTP（Bearer 会话令牌；服务端注入身份）
   ┌──────────────────────────────────────────────────────────────────┐
   │  Server（Express）  鉴权 → 路由 → 用例服务                        │
   │  cases / materials / inquiry / elements / contradictions /        │
   │  element-graph / review / overview / report / audit / admin       │
   │                                                                    │
   │  ┌── OfflineGuard（零外发裁决）  每次出站 authorize(endpoint,…) ─┐ │
   │  │  五模型槽（configured⟺真槽，空端点⟺mock，不可分叉）          │ │
   │  │  OCR=PaddleOCR(本地) ASR=FunASR(本地) Embed/Rerank/VLM=可替换  │ │
   │  └────────────────────────────────────────────────────────────────┘ │
   │  Citation 裁决：resolveValidCitations（content_hash 校验，唯一关口）│
   │  AuditService：哈希链 append-only（payload/prev/event_hash）        │
   └──────────────────────────────────────────────────────────────────┘
                                  │
   ┌──────────────────────────────────────────────────────────────────┐
   │  Core（mini-agent 纯文本内核）  确定性 Agent loop + 工具 + 流式   │
   └──────────────────────────────────────────────────────────────────┘
                                  │
   纯文件存储（每专题一目录）：manifest / *.chunks.jsonl / .vec /
   elements.json / contradictions.json / audit 镜像 / report
```

**摄入→分析→报告 一条主链**（下游对模态无感，统一杠杆）：

```
素材 ─ 摄入即加工 ─►  切块(content_hash=sha256(text))  ─► 索引(BM25 + dense .vec, best-effort)
  ├ 文档：本地 lit 解析 PDF/Office → 页级切块（扫描件回退 lit 渲染 + PaddleOCR）
  ├ 音频：FunASR → 句级时间戳 + 说话人 → 带 timecode/speaker 的切块
  ├ 图像：VLM 画面描述 + PaddleOCR 文字 → 切块
  └ 视频：ffmpeg 场景分镜 → 逐镜头 VLM + ASR + 关键帧 OCR → 带 timecode 的切块
                                   │
   检索（token 预算路由 → hybrid RRF → reranker；CR/改写/HyDE opt-in）
                                   │
   问答(harness: search/read/cite/finalize，逐条引用) ＋ 要素抽取
                                   │
   ★ 交叉验证/矛盾检测   ★ 要素关系网络/时间线
                                   │
   报告（复核闸门 draft→submit→approve→export）  ＋  全程哈希链审计
```

### 2.3 关键设计决策与合理性

**① 为什么把"逐字引用"做成结构性裁决，而非提示词？**
LLM 编造出处是公认风险。本项目把唯一裁决点收敛到 `resolveValidCitations`：结论引用必须命中真实切块的 `content_hash`，否则丢弃；**LLM 生成/改写的文本永不进入 `chunk.text` / `content_hash` / 被引用片段**。这样即使提示词被篡改也无法伪造溯源——可验证性是结构保证，不是模型自觉。

**② 为什么矛盾检测用"锚定 + 成对 NLI"，而不是把全文丢给 LLM 找矛盾？**
直接让 LLM"找矛盾"会产出不可接地、不可扩展、单次调用随语料增大丢上下文的结果。本项目把不确定性收口到最小结构里：LLM 只做①逐块抽原子主张 和③簇内成对判定，**聚类（②）与置信度（④）是确定性计算**；每条矛盾两侧都绑定 content_hash 精确块。benchmark 证明这在玩具集 F1 上**追平直出（0.957=0.957）**，且赢在 **precision 1.0 + 逐条 provenance + 全语料可扩展 + 可审计**（§3.2）。

**③ 为什么关系网络/时间线是确定性聚合，而非 LLM 生成？**
图谱/时间线一旦由 LLM"画"出来，节点与边就不可验证、可能臆造。本项目改为对已落盘要素的**纯确定性派生**：共现边 = 两要素同切块（content_hash）出现，权 = 共现块数，边携逐字引用；时间线按确定性解析的时间锚排序。无 LLM、无出站、可点跳源。

**④ 为什么五模型槽 "configured ⟺ 真槽 / 空端点 ⟺ mock" 不可分叉？**
真槽（会出站）与端点同源派生：有 `baseURL && model && host` 才是真槽，且真槽出站前必经 `OfflineGuard.authorize`。这把"零外发"做成不可被错误配置绕过的不变量——真槽必授权，mock 进程内不出网。

**⑤ 为什么本地子进程（ffmpeg / lit / PaddleOCR）不经 OfflineGuard，却仍安全？**
它们属"本地信任类别"（不连公网），但**绝不接收网络 URL**：ffmpeg 调用一律带 `-nostdin -protocol_whitelist file,pipe`（堵恶意容器经 concat:/playlist 外连），lit 钉死不传 `--ocr-server-url`，路径经 `assertLocalFile`/`assertSafeId` 校验。信任边界以显式注释 + 测试守住。

### 2.4 大模型编程工具的应用方法

1. **规格协同**：先与大模型编程工具协作产出 spec 与红线不变量，把"做什么/怎么验收/不能越界什么"前置固定。
2. **对抗式实现-评审闭环**：Codex 实现 → Codex + Opus 双独立评审 → 人工裁决分歧 → 本地门禁。多次靠该闭环逮到真问题（如视频摄入的气隙外连洞、摄入路径漏授权、聚类粒度导致召回崩塌）并修复。
3. **受管提示词**：系统提示词外置为可编辑、版本化的"受管提示"（admin 后台可改 + 版本回溯），但红线在 harness 层强制、改提示词绕不过。
4. **benchmark 驱动**：自造带标注语料，量化对比自研 skill 与大模型直出，用数据而非主观判断定位价值与边界。
5. **诚实留痕**：决策日志记录负结果与误报裁决，保证过程可复述、结论可质疑。

### 2.5 能力目标达成对照

| 能力目标 | 落地点 |
| --- | --- |
| 使用 LLM / 本地模型 | OpenAI 兼容适配器驱动问答 loop；五模型槽（本地 PaddleOCR/FunASR + 可替换 Embed/Rerank/VLM） |
| prompt engineering | 受管提示词（可编辑+版本化）；要素/矛盾抽取与判定的分目的指令 |
| function / tool calling | 问答 harness 的 search/read/cite/finalize 只读工具；摄入期多模态工具 |
| 业务逻辑拆分 | 摄入/检索/问答/要素/矛盾/关系网络/报告/审计/鉴权 分服务 |
| 多模态系统 | 文档/音频/视频/图像 摄入即加工，带 timecode/bbox/speaker 定位 |
| tool routing | 按模态路由 ASR/VLM/OCR；检索按 token 预算路由全上下文 vs 混合检索 |
| 失败与异常处理 | 摄入失败优雅降级 pending+note；索引/上下文 best-effort 不崩；模型不可达退 BM25；降级落审计 |
| 完整 pipeline + 创新 | 摄入→检索→问答→要素→**矛盾检测/关系网络**→报告→审计，端到端可溯源 |

---

## 三、应用效果分析

### 3.1 检索质量 benchmark（含诚实负结果）

语料：DeepSeek 合成情报域 **45 文档 / 227 切块 / 100 标注 query**；检索栈 BM25⊕dense RRF + Qwen3-Reranker（embed=Qwen3-Embedding-8B，dim 4096）。

| 变体 | hybrid R@10 | hybrid MRR@10 | rerank MRR@10 | rerank nDCG@10 |
| --- | ---: | ---: | ---: | ---: |
| baseline | **0.950** | 0.833 | 0.915 | 0.924 |
| Contextual Retrieval | 0.950 | 0.809 | **0.923** | **0.930** |
| query rewrite | 0.930 | 0.786 | 0.885 | 0.896 |
| HyDE | 0.920 | 0.720 | 0.737 | 0.782 |

**结论（诚实）**：强 hybrid+rerank 基线在清洁合成基准上近饱和（R@10=0.95），通用 RAG 增强**总体不增益**——CR 仅在重排微增，改写/HyDE 反降。三者均实现且 opt-in 默认关，价值在脏/欠定语料而非本基准。**敢于报告负结果并据此做工程决策，本身是规范性的体现。**

### 3.2 ★ 核心实验：自研矛盾检测 vs 大模型直出

语料：自造带标注案卷 **30 切块 / 6 虚构文件 / 12 条金标矛盾对**（跨/内 + 干扰项）。

| 方案 | Precision | Recall | F1 | TP/FP/FN |
| --- | ---: | ---: | ---: | --- |
| **anchored（NLI 关思考，默认）** | **1.000** | **0.917** | **0.957** | 11 / **0** / 1 |
| anchored（NLI 开思考） | 1.000 | 0.833 | 0.909 | 10 / 0 / 2 |
| llm-direct（全块丢 LLM 列矛盾） | 1.000 | 0.917 | 0.957 | 11 / 0 / 1 |

**实验过程（真实，含两次"假设被数据推翻"）**：① 聚类粒度——初版按 `entity:attribute` 精确串聚类对属性表层差异过敏（簇全 size-1，F1≈0.29 惨败）→ 改按**实体聚类**（attribute 交簇内 NLI 判）。② **思考分流**——曾假设「成对 NLI 是难判定 → 开思考求质量」，实测**反例**：开思考 F1=0.909（recall 0.833）**反低于**关思考 0.957（推理模型「想多了」把真矛盾判 unrelated）→ 按数据把 NLI 默认改回关思考。③ 机制修复——核心适配器原发 `max_completion_tokens`（DeepSeek 静默忽略，token 上限失效）+ 推理模型思维链税，令旧版 anchored 仅 0.737；改发 `max_tokens` + 关思考后 **0.737 → 0.957，追平 llm-direct**。

**价值定位（这是拿分的关键论证）**：锚定流水线（关思考）在原始 **F1 上已追平大模型直出（0.957 = 0.957）**，并额外给出直出给不出的：
- **可验证 provenance**：每条矛盾两侧各绑定 content_hash 精确块，precision 1.0，可点可审；直出只吐 `chunk_id` 对、无接地校验。
- **可扩展（已做实）**：逐块抽 + 仅簇内成对判（O(Σnᵢ²)）+ **分批覆盖全语料 + 确定性合并**（大专题 1667 块全覆盖，后台任务跑），不随语料增大而单次调用丢上下文；直出在大语料必丢上下文。
- **可审计**：每次出站经 OfflineGuard、每步入哈希链审计。
- **benchmark 驱动**：thinking on/off 机制 + 对照实验 + 让数据定默认——「设计完 benchmark 验证」闭环。

→ 即自研 skill 既不输玩具集 F1，又赢在**情报域真实约束下的可溯源/可扩展/可审计**——这正是"套壳大模型直出"给不出的。完整 benchmark 见 `docs/report/benchmark-summary.md`。

### 3.3 系统级效果与鲁棒性（均有测试佐证，门禁 620/2 绿）

- **逐字引用不变量**：有上下文增强（Contextual Retrieval）时，引用仍过 content_hash 校验；伪造 chunk_id 被 `resolveValidCitations` 丢弃。
- **零外发不变量**：grep 验证每个出站点前都有 `OfflineGuard.authorize`；真槽 ⟺ 非空端点不可分叉；摄入期 embed/媒体出站补齐授权（评审 BLOCKING 修复）。
- **摄入鲁棒性**：云 embed 不可达时上传仍 `done`（退 BM25，挂 note），不再误报"解析失败"；摄入失败优雅降级 pending+note 并落审计。
- **多模态真链路**：FunASR 真转写恢复句级时间戳+说话人；图像型 PDF→lit→真 PaddleOCR→页级切块端到端亲验；真 ffmpeg 分镜/抽帧亲验（含气隙白名单旗标）。
- **访问控制**：真用户系统（服务端会话 + scrypt + 令牌，客户端不能自报身份）；四级密级裁剪贯穿专题列表、跨专题总览、矛盾/要素读取。

### 3.4 方法对比与先进性

| 维度 | 大模型直出 / 套壳 | 纯云 RAG 工具 | **本工作台** |
| --- | --- | --- | --- |
| 溯源 | 无接地/可编造 | 多为段级、不可验证 | **逐字 content_hash，结构性不可伪造** |
| 零外发 | — | 云端、不可气隙 | **OfflineGuard 显式授权，可整体拒绝** |
| 矛盾/交叉核验 | 单次直出、不可扩展 | 一般不提供 | **锚定+成对 NLI，precision 1.0，逐条 provenance** |
| 关系网络 | LLM 臆造、不可验证 | 黑盒 | **确定性共现聚合，可点跳源** |
| 审计 | 无 | 有限 | **哈希链 append-only，含失败/拒绝路径** |
| 部署 | 云依赖 | 云依赖 | **本地优先、模型可替换、气隙友好** |

> 先进性边界（如实说明）：分析 skill 的 benchmark 为中小自造语料；规模化（更大更难语料让直出掉精度、嵌入式实体归并推召回）是直接增强方向（见 §五）。

---

## 四、复现实验

```bash
# 0. 安装与质量门禁（typecheck + 全量测试，离线可跑）
npm install
npm run check        # 78 测试文件 / 620 通过 / 2 跳过

# 1. 启动工作台（开发期：source dev.env.sh 注入云替身/本地服务端点）
source dev.env.sh
npm run dev:server   # http://127.0.0.1:4319
npm run dev:web      # Vite 代理 /api → 浏览器进入作业面

# 2. 检索 benchmark（真模型，独立于 check）
npm run eval                      # baseline
npm run eval -- --variant=cr      # / qrewrite / hyde

# 3. 矛盾检测 benchmark（锚定流水线 vs 大模型直出）
npm run eval:contradiction

# 4. 本地模型服务（部署期全本地；开发期可选起）
#    PaddleOCR → 127.0.0.1:8000 ；FunASR → 127.0.0.1:8001
```

> 结果落盘：检索 `packages/server/eval/results/`，矛盾检测 `packages/server/eval/contradictions/results/`；汇总见 `docs/report/benchmark-summary.md`。

---

## 五、局限与展望

- **分析 skill 规模化评测**：引入更大、更难（欠定/多跳/跨块）的标注语料，让大模型直出在规模上掉精度，empirically 凸显结构化优势；矛盾检测加**嵌入式实体归并**推高召回（当前残余漏判=实体串表层变体）。
- **多说话人 diarization 调优**：FunASR cam++ 在合成双声测试上聚为单一说话人，待真多说话人录音验证/调阈。
- **扫描件空间高亮**：OCR 行级 bbox → 切块级高亮回放（已留接口）。
- **本地文本 LLM 真 tool-calling 冒烟**：开发期以云替身 + scripted adapter 验收，待本地 OpenAI 兼容端点做 strict function-calling 冒烟。

---

## 六、交付物清单

- **源代码**：`packages/core`（mini-agent 内核）、`packages/server`（后端 + 五模型槽 + OfflineGuard + 各用例服务 + 自研分析）、`packages/web`（双面工作台）。
- **自研分析能力**：`server/src/analysis/contradiction-service.ts`（矛盾检测）、`analysis/element-graph.ts`+`element-graph-service.ts`（关系网络/时间线）。
- **过程文件**：`docs/specs/`（规格先行）、`docs/report/rag-quality-decision-log.md`（D8–D19 决策日志，含负结果与裁决）、`docs/report/benchmark-summary.md`（benchmark 汇总）、本报告。
- **测试与评测**：`packages/server/tests/`（78 文件 / 620 测试）、`packages/server/eval/`（检索 + 矛盾检测语料、runner 与结果）。
- **文档**：README、`docs/HANDOFF.md`（交接）、`docs/architecture*.html`、`docs/{tutorials,how-to,reference,explanation}`。
