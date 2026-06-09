# 情报分析工作台 · 二期工程方案（多模态 + RAG）

> 配套规格：`intel-workbench-phase2-multimodal-rag-spec.md`（设计/契约）。本文是**实施计划**：里程碑、触碰文件、验收标准、依赖。
> 一期工程：`intel-workbench-phase1-engineering-plan.md`。可视化：`docs/architecture.html`。
> v2（2026-06，已过 opus 评审 SOUND-WITH-FIXES）。评审三阻塞项已并入：**manifest 写入需先串行化**（§P2.3a 第一步）、**重加工 Citation 失效规则**（采新 chunk_id 版本化，Spec §2.5）、**P2.0 类型原子提交**；并把 **P2.3 拆为 P2.3a（音频）/ P2.3b（视频图像）**、补 **25MB 上传墙**修复。

---

## 0. 给接手 Agent 的上手须知（先读这段）

**项目**：情报分析工作台 = 气隙离线情报处理与多模态分析系统。Monorepo（npm workspaces）：
- `packages/core`（私有内部包 `mini-agent`）：agent 运行时 + **模型适配器** `createModelAdapter({provider:"openai-compatible",...})`。
- `packages/server`（Express 5, ESM, TS）：API + 服务层。**业务都在这里。**
- `packages/web`（React 19 + Vite）：作业面/管理面/审计中心。

**怎么跑**：`npm install` → `npm run build`（必须先建 core，server/web 依赖其 dist 的 .d.ts）→ `npm run dev:server`(:4319) + `npm run dev:web`。
**门禁**：`npm run check`（= typecheck 全包 + `vitest run`）。当前基线 **362 通过 / 2 跳过**。任何里程碑必须保持绿。
**服务端测试**：`packages/server/tests/*.test.ts`，service 级 + 临时 dataDir + **mock 适配器**（见 `tests/elements.test.ts`/`auth.test.ts` 范式）。`vitest.config.ts` 有 alias `mini-agent → packages/core/src/index.ts`——别动。

**三条红线（任何改动都不能破）**：
1. **Citation 溯源**：每条 AI 结论必须引用一个被取用的 chunk，且 `sha256(chunk.text)===chunk.content_hash`，否则降"待核"/拒答。核心在 `inquiry/citation.ts` `resolveValidCitations`。
2. **零外发 OfflineGuard**（`security/offline-guard.ts`）：任何模型出站前 `guard.authorize(url,{user,purpose})`，非白名单 403 + 审计。
3. **审计哈希链**（`audit/audit-service.ts`）：append-only，`payload_hash/prev_hash/event_hash`，可 `verify()`。

**关键契约（已存在，二期复用）**：
- `Chunk{chunk_id, material_id, locator, text, content_hash}` 落 `cases/<id>/processed/<mid>.chunks.jsonl`。
- `MaterialService.loadCaseChunks(caseId)` 读所有 `done` 素材的 chunks —— **问答/要素都从这里取材**。
- `InquiryService.ask` 管线：`retrieve(BM25)` → 无命中拒答 → `guard.authorize` → `generateJson`(结构化) → `resolveValidCitations` 校验 → 落 `inquiries.jsonl` + 审计。
- `LlmDeps{adapter, guard, modelEndpoint}` + `generateJson(adapter, sys, user, opts)`（`model/structured.ts`）。
- 媒体当前**降级 pending**（`material-service.ts` 的 `DEGRADE_NOTE`）——二期要替换成真加工。

**⚠️ 评审揪出的现状陷阱（动手前必知）**：
1. **manifest 写入未串行化**：`CaseService.attachMaterial`/`writeManifest` 是无锁 read-modify-write。**只有审计链**走单写者队列。引入异步加工/并发 process 前，**必须先把 manifest 变更接入 per-case 串行队列**（core 已有 `packages/core/src/tools/file-mutation-queue.ts`，复用它）——这是 P2.3a 第一步，否则丢素材/丢状态。
2. **`loadCaseChunks` 以 `status==="done"` 为准且吞 ENOENT**：媒体加工必须**先写完 chunks 文件→再翻 done→再审计**，否则并发问答读到"done 但零 chunk"静默漏料。
3. **持久化的 Citation 不复检**：`resolveValidCitations` 只在生成时跑。重加工改 `content_hash` 会**静默失效历史引用**——本期采"重加工生成新 chunk_id 版本"避免（Spec §2.5）。
4. **25MB base64-in-JSON 上传装不下真实音视频**（≈18MB 原始）——P2.3a 需多部分/流式上传（Spec §4.6）。

**二期核心思路（务必内化）**：音/视/图不是新子系统，只是**新的 chunk 生产者**。只要媒体加工产出与文档相同格式的 `chunks.jsonl`（带 `modality` + `timecode/bbox` locator + `content_hash`）并置 `done`，则 `loadCaseChunks`/检索/Citation/问答/要素/报告**全部不改即生效**。这是整个二期的杠杆点。**先 mock 后真模型**：本期建接口与管线骨架，模型权重落地是部署方的事。

---

## 1. 里程碑总览

| 里程碑 | 名称 | 模型依赖 | 产出 |
| --- | --- | --- | --- |
| **P2.0** | 数据模型打底 | 无 | ChunkLocator 扩展、Chunk.modality、chunkToCitation 修正、文档 char 偏移 |
| **P2.1** | RAG token 预算路由 | 无 | 全上下文 ↔ BM25 按阈值切换，问答/要素共用 |
| **P2.2** | 模型适配器槽（mock-first） | 无（mock） | Embedding/Reranker/ASR/VLM/OCR 接口+配置+Guard 白名单+mock |
| **P2.3a** | 媒体管线·音频垂直切片 | mock | **manifest 串行化** + 多部分上传 + 状态机/崩溃清扫 + process 端点 + **音频**管线 + web |
| **P2.3b** | 媒体管线·视频/图像 | mock | 分镜/帧存储 + VLM 配文 + OCR（多 chunk 类型/素材）+ web |
| **P2.4** | 稠密检索 + 混合 RRF | mock embed | 向量索引（带版本戳）+ 进程内余弦 + RRF 融合 + BM25 兜底 |
| **P2.5** | 重排（可选、门控） | mock rerank | Reranker 二阶段 |
| **P2.6** | 真实模型接入 + 评测 | **阻塞于部署** | FunASR/VLM/Embed 真端点 + 真实素材头对头评测 + 调参 |

P2.0–P2.5 **现在就能做**（mock）；P2.6 阻塞于本地模型部署（用户范围外），但 P2.2 的适配器接口让其"插上即用"。

> **本期默认不做（评审建议留三期，待用户确认）**：跨专题知识库 sqlite-vec、Contextual-Retrieval 上下文头、父子切块。二期范围 = 专题内多模态 + 预算路由 + 进程内稠密检索。

---

## 2. 里程碑细化

### P2.0 数据模型打底（无模型依赖）

**目标**：让 chunk/citation 能承载媒体出处，不破坏现有文档管线。

- 复用：`domain/types.ts`、`materials/material-service.ts` `chunkText`、`inquiry/citation.ts`。
- 新增/改：
  - `types.ts`：`ChunkLocator`（加 `char_start/char_end/timecode/bbox/speaker/frame`）；`Chunk` 加 `modality`；`Citation.locator` 对齐补 `char_start/char_end/speaker/frame`。
  - `material-service.ts chunkText`：产出 `modality:"doc"` + `locator.char_start/char_end`（在归一化文本中的偏移）。
  - `citation.ts chunkToCitation`：`modality: chunk.modality ?? "doc"`，`locator` 整体透传（含时间码/bbox）。
- **兼容**：旧 chunks.jsonl 无新字段——读取时 `modality` 缺省 `"doc"`、locator 旧字段照用。
- ⚠️ **原子提交（评审阻塞项）**：`Chunk.modality` + `ChunkLocator` 加宽 + `Citation.locator` 加宽 + `chunkToCitation` 透传**必须同一提交**，否则透传通不过类型检查。
- **验收**：`npm run check` 绿；新增测试：doc chunk 带 char 偏移且偏移切片==原文；`chunkToCitation` 对 audio chunk 透传 timecode/speaker/正确 modality；旧格式 chunk 仍可解析问答。

### P2.1 RAG token 预算路由（无模型依赖，**最高 ROI，建议先做**）

**目标**：小数据走全上下文（消除召回瓶颈），大数据才检索。

- 复用：`inquiry/retrieval.ts retrieve`、`inquiry-service.ts`、`elements/element-service.ts`（取材处）。
- 新增/改：
  - `inquiry/retrieval.ts`：加 `estTokens(chunks)`（中文≈字符、英文≈chars/4 粗估）+ `selectContext(query, chunks, budget)` → 返回 `used: Chunk[]`（≤预算返回全集；否则 `retrieve` top-k）。
  - `model/model-config.ts` 或新 `rag-config.ts`：读 `MINI_AGENT_CTX_BUDGET_TOKENS`（默认保守值，待 §8 决策确认）。
  - `inquiry-service.ts ask`：用 `selectContext` 取代直接 `retrieve`；`retrievedById` 用 `used`。全上下文模式下 `hits.length===0` 的拒答判据改为"专题无任何 chunk"——**但保留第③条拒答（所有 claim 过不了 `resolveValidCitations` → insufficient），这是全上下文下守红线的关键**。
  - 要素抽取同理；**预算路由统一取代 `element-service.ts` 现有的 `MAX_CHUNKS=60` 静默截断**（评审：勿叠加，否则一边报全上下文一边丢块）。
  - **opt-in（评审）**：`MINI_AGENT_CTX_BUDGET_TOKENS` 不设默认；未配置退一期 BM25 top-6。`estTokens` **fail-safe**：近预算 80% 即走检索；估算计入每 chunk `[chunk_id] ` 框架开销。
- **验收**：小专题（少量 chunk）→ 全上下文模式，模型引用任一 chunk_id 都能校验；大专题（造 > 预算的 chunk）→ 走 BM25；未设预算 env → 退 top-6。三路 Citation 校验都过，第③条拒答仍生效。新增测试覆盖三分支 + 边界 + MAX_CHUNKS 取代。真机 DeepSeek 冒烟：小专题问答质量不被 top-k 截断。

### P2.2 模型适配器槽（mock-first，无真实模型）

**目标**：为 Embedding/Reranker/ASR/VLM/OCR 建统一接口、配置、OfflineGuard 接线，mock 实现。

- 复用：`model/model-config.ts`、`security/offline-guard.ts`、`app.ts`（装配）。
- 新增（`packages/server/src/model/`）：
  - `slots.ts`：接口 `EmbeddingAdapter.embed`、`RerankerAdapter.rerank`、`AsrAdapter.transcribe`、`VlmAdapter.caption`、`OcrAdapter.ocr`（形态见 Spec §3.2/§3.3）。
  - `slot-config.ts`：读各 `MINI_AGENT_{ASR,VLM,OCR,EMBED,RERANK}_BASE_URL/MODEL/API_KEY`；返回 `{configured, host, ...}`。
  - `mock/`：`MockAsr`（按时长造确定性段+说话人）、`MockVlm`、`MockOcr`、`MockEmbed`（确定性向量，如基于 token hash）、`MockReranker`。开关 `MINI_AGENT_USE_MOCK_MEDIA`。
  - `app.ts`：构建各 adapter（real 若配置、否则 mock 若开关、否则 null）；**所有已配置/启用槽的 host 并入 OfflineGuard 白名单**。
- **验收**：`npm run check` 绿；测试：mock 适配器确定性输出；`OfflineGuard` 对未配置槽端点拒绝（403+审计）、对已配置槽放行；`slot-config` 缺失 env → `configured:false`。

### P2.3a 媒体管线 · 音频垂直切片（mock，**证明杠杆点的端到端切片**）

**目标**：音频素材真正产出可引用 chunk 并进入溯源管线；同时把异步加工所需的安全底座一次补齐。**先做这些底座，再做音频管线**：

- **底座（评审阻塞项，先于一切 worker）**：
  - **manifest 串行化**：`CaseService` 所有 manifest 变更接入 per-case 串行队列（复用 core `file-mutation-queue.ts`）。测试两并发 `process`/`ingest` 不丢素材。
  - **多部分/流式上传**：媒体绕开 25MB base64-in-JSON（Spec §4.6）；文本保留旧路径。
  - **崩溃清扫**：启动时扫 `processing` → `failed`（带 note），令 `loadCaseChunks` 不漏、UI 可重试。
  - **提交点顺序**：`.chunks.jsonl`/`.media.json` 完整写盘（temp→rename）→ 翻 `done` → audit。
- 复用：`material-service.ts`（落盘/loadCaseChunks）、`audit-service.ts`、`util/hash.ts`、citation/inquiry（不改即生效）。
- 新增/改：
  - `materials/media-pipeline.ts`：`processAudio(material, asrAdapter)` → `AsrResult` → `Chunk[]`（modality:"audio"，locator.timecode/speaker，content_hash）+ `media.json`。
  - `material-service.ts`：媒体 ingest 置 `pending`；`process(actor,caseId,mid)`：`pending→processing→`管线`→done|failed`，**幂等**（重 process 生成新 chunk_id 版本，replace 不 append，Spec §2.5），落 `material.process` 审计；`Material` 加 `duration/processed_at/engine`。
  - `POST /api/cases/:id/materials/:mid/process`（显式触发）。
  - web：`MaterialsPanel` 媒体状态 + "加工/重试"按钮；阅读区展示转写段+说话人；问答引用 `timecode` → **可回听原片段**（取原始 `materials/`，§硬验收）。
- **验收**：mock ASR → `done` + chunks 带 `timecode/speaker/content_hash`；问答能引用到音频 chunk（Citation 带 timecode）；**复核员能回听被引用片段**（硬验收）；审计 verify ok 含 `material.process`/`egress.*`；两并发 process 不丢状态；注入崩溃→`processing` 被清扫为 `failed`；重 process 幂等不重复入库。注：P2.4 前音频 Q&A 走**全上下文路径**验收（BM25 对无标点转写召回弱）。

### P2.3b 媒体管线 · 视频 / 图像（mock）

- 新增/改：
  - `processVideo`：demux(ffmpeg) → 分镜(TransNetV2) → 关键帧存 `processed/<mid>.frames/<t>.jpg` → 每镜头 VLM 配文 + 音轨走 `processAudio` + 帧 OCR → 三类 `Chunk`（均 modality:"video"，locator.timecode/bbox/frame）。
  - `processImage`：VLM 配文 + OCR → `Chunk`（modality:"image"，locator.bbox）。
  - `GET /api/materials/:mid/frame?t=<timecode>` 取帧端点（bbox 引用回放）。
  - web：阅读区按模态展示；bbox 引用在帧上框选。
- **验收**：视频 mock → 配文+转写+OCR 三类 chunk 各带正确 locator；bbox 引用可取到帧并框选；图像 OCR-only → bbox chunk 可被引用；部分失败（VLM ok/OCR fail）→ done + note。

### P2.4 稠密检索 + 混合 RRF（mock embedding）

**目标**：检索路升级为 BM25 ⊕ dense。

- 复用：`retrieval.ts`、P2.2 EmbeddingAdapter。
- 新增/改：
  - 入库加工时 `embed(chunk.texts)` 写 `cases/<id>/index/<mid>.vec`（Float32 blob，**头部带 `{embed_model, dim, count}` 版本戳**，与 chunks 同序、同提交）；embedding 未配置则跳过。
  - **读时校验版本戳**：与当前 embed 配置不符（换模型/维度变）或 `count` 与 chunks 数不符 → 忽略该 `.vec`、退 BM25-only、标"待重建索引"（评审：否则维度不匹配抛错/算垃圾）。
  - `retrieval.ts`：`denseSearch(queryVec, vecs)`（进程内余弦 top-N）；`rrf(bm25Ranked, denseRanked, k=60)`；`retrieveHybrid` 整合，embedding 不可用时退 BM25-only。
  - 接入 §5.1 检索路分支。
- **验收**：mock embed 下混合检索可运行且 BM25-only 退化正确；测试：RRF 融合顺序符合公式；缺向量/**维度不符**时不报错退 BM25 并标待重建；`.vec` 与 chunks 同提交、count 对齐。
- **说明**：mock embed 是 hash 向量、**无语义**，故只验"接线/融合公式/退化"，**不验检索质量**——质量是 P2.6（真模型）才评。

### P2.5 重排（可选、门控）

- 新增：`retrieval.ts` 接 `RerankerAdapter`；`MINI_AGENT_RERANK_*` 配置且候选数超阈值才启用，作为 top-N→top-k 二阶段。
- **验收**：mock rerank 改变 top-k 顺序；默认关闭路径不变；门控阈值生效。

### P2.6 真实模型接入 + 评测（**阻塞于本地模型部署**）

- FunASR（fsmn-vad + 引擎槽 + cam++）、VLM（MiniCPM-V 4.5 / Qwen3-VL）、Embedding/Reranker（Qwen3 系）以**本地 HTTP 端点**暴露，real adapter 接入（替换 mock）。
- 真实截获音视频**头对头评测**（精度/时间戳/显存/速度），定引擎、定 `CTX_BUDGET`、定是否上重排/Contextual 头。
- **此里程碑只在模型就绪后做**；本期把 adapter 接口与 OfflineGuard 接线备好即可"插上即用"。

---

## 3. 测试与验收策略

- 每里程碑配 service 级 vitest（临时 dataDir + mock 适配器），覆盖：红线（Citation hash 校验、Guard 拒放、审计 verify）、状态机、降级路径、边界。
- **评审补的必测项**：① 两并发 `process`/`ingest` 不覆盖 manifest（串行化）；② 崩溃后 `processing` 被清扫；③ `.vec` 维度不符退 BM25；④ 重 `process` 幂等不重复入库、历史 Citation 不失效；⑤ P2.1 三拒答路径（零 chunk / 模型 insufficient / 全 claim 失效）。
- 红线回归是**硬门**：任何里程碑后 `resolveValidCitations` 对伪造/篡改 chunk 仍拒、`OfflineGuard` 对未白名单端点仍 403、审计链仍 verify ok。
- 每个"做实"里程碑做一次**真机/mock 端到端冒烟**（仿一期：建专题→汇入→加工→问答带溯源→审计 verify）。
- 保持 `npm run check` 绿；新增测试只增不减既有 362。

---

## 4. 风险与对策

| 风险 | 对策 |
| --- | --- |
| **manifest 并发覆盖（评审阻塞）** | P2.3a 先把 manifest 变更接 per-case 串行队列（复用 core file-mutation-queue），再上 worker |
| **重加工失效历史 Citation（评审阻塞）** | 重加工生成新 chunk_id 版本，旧引用仍对旧 chunk hash 一致（Spec §2.5） |
| **25MB 上传装不下真实媒体（评审）** | P2.3a 多部分/流式上传，绕 base64-in-JSON |
| **done-但零-chunk 静默漏料（评审）** | 提交点顺序：chunks 完整写盘→翻 done→审计 |
| **崩溃留下永久 processing（评审）** | 启动清扫 processing→failed；process 幂等可重触发 |
| **换 embed 模型致 .vec 维度不符（评审）** | `.vec` 带版本戳，读时不符即退 BM25 + 标待重建 |
| 媒体加工慢阻塞请求 | ingest 与 process 分离；process 异步/显式；单机串行队列 |
| Python 模型与 Node 边界 | 统一本地 HTTP 端点接入，Node 侧零 Python 依赖、统一过 Guard |
| 全上下文塞满致多事实召回下降 | 预算阈值取窗口 ~50–60%；`estTokens` fail-safe，近 80% 即走检索 top-k |
| ANN 漏匹配伤溯源 | 先精确（暴力余弦 / sqlite-vec vec0），规模逼近上限再评 ANN |
| 旧 chunks 无新字段 | 字段全可选 + 缺省 modality=doc；P2.0 兼容测试 |
| 媒体引用保真度（转写≠音频） | 诚实声明绑定的是转写；复核员回放原片段为硬验收 |
| 模型未配置 | 降级 failed + note，不阻断专题；mock 开关供开发 |

---

## 5. 建议执行顺序

```
P2.0  数据模型打底        （半天，纯类型+小改一原子提交，解锁后续）
P2.1  RAG 预算路由        （最高 ROI，立刻提升小数据质量，无模型依赖）
P2.2  适配器槽 + mock     （解锁媒体与稠密检索的骨架）
P2.3a 音频垂直切片        （先补底座：manifest 串行化/上传/清扫/提交序；再 FunASR 形态音频管线——证明杠杆点的端到端切片）
P2.3b 视频 / 图像         （分镜/帧存储/VLM/OCR；不阻塞音频win）
P2.4  稠密检索 + RRF      （.vec 带版本戳）
P2.5  重排（可选）
──────── 以上 mock 可全部跑通、门禁绿 ────────
P2.6  真实模型接入 + 评测  （待本地模型部署）
```

每步遵循一期节奏：**实现 → npm run check 绿 → 端到端冒烟 → 提交 → 子代理审核**。
