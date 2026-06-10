# 情报分析工作台 · 二期技术规格：多模态入库 + RAG 检索

> 状态：草案 v2（2026-06，已过 opus 子代理架构评审，结论 SOUND-WITH-FIXES，下列改动已并入）。本文是**设计规格（Spec）**，回答"做什么/怎么设计"；实施步骤见配套《二期工程方案》`intel-workbench-phase2-engineering-plan.md`。
> 配套可视化：`docs/architecture.html`（当前 vs 推荐架构图解）。模型选型依据见记忆 `offline-media-rag-architecture.md`。
>
> **评审并入的关键修正（务必读）**：① manifest 写入当前**未串行化**，引入异步加工前必须先接 per-case 串行队列（§4.1，阻塞项）；② 重加工会改 content_hash 致**历史 Citation 静默失效**，定了失效规则（§2.5，阻塞项）；③ `ChunkLocator` 与 `Citation.locator` 必须**同一提交**加宽（§2.2，阻塞项）；④ 25MB base64 上传**装不下真实音视频**，需多部分/流式上传（§4.6）；⑤ `.vec` 需带模型/维度版本戳，不匹配回退 BM25（§5.3）。

---

## 0. 背景与目标

一期已交付**文本专题完整闭环**（建专题→汇入加工→要素抽取→问答带溯源→报告复核闸门→导出）+ 真实登录鉴权 + 用户管理，三条红线（零外发 / 审计哈希链 / Citation 溯源）在服务层强制。当前缺口：**媒体（音频/视频/图像/二进制文档）一律降级 pending**，且问答**永远先检索**（小数据下不必要且压制质量）。

二期补两件事，**且不动任何红线**：

1. **多模态入库**：音频/视频/图像在汇入时真处理成"带时间码/坐标的可引用 chunk"，进入与文本完全相同的溯源/问答/要素/报告管线。
2. **RAG 检索升级**：把"必检索"改为**按 token 预算路由**——小数据全上下文、大数据/知识库才检索（BM25 ⊕ dense via RRF + 可选重排）。

### 0.1 非目标（明确不做）

- **不做本地模型部署/量化**（用户范围外）。本期只建**适配器接口 + 管线骨架**，先用 mock，权重到位即插即用。
- **不做云模型**。所有模型槽指向本地/兼容端点，经 OfflineGuard 授权。
- **不引入重型依赖**（向量库优先零依赖/单文件；不上 FAISS/LanceDB）。
- **不改红线语义**（Citation/审计/OfflineGuard 行为不变，仅扩展数据字段与新增审计动作）。

---

## 1. 指导原则（架构不变量）

| 原则 | 含义 | 落点 |
| --- | --- | --- |
| **chunk 是唯一通用单元** | 音/视/图不是新子系统，只是新的 chunk 类型 | 所有模态产出 `Chunk{chunk_id, material_id, locator, text, content_hash}`，落同一个 `processed/<id>.chunks.jsonl` |
| **溯源 ≠ 检索（解耦）** | 检索只决定"哪些 chunk 进上下文"；溯源永远靠 `content_hash` 事后校验 | `resolveValidCitations` 不变；全上下文与检索两路都过同一校验 |
| **模型槽可插拔** | LLM/Embedding/Reranker/ASR/VLM 全是可替换的本地端点 | 统一适配器接口 + 配置 + OfflineGuard 白名单；mock-first |
| **入库时重处理、查询时轻** | ASR/VLM 重算力摊到汇入一次（可批/异步），查询只跑检索+文本 LLM | 媒体加工为异步 job；查询路径不调媒体模型 |
| **降级而非阻塞** | 模型未配置/失败时，素材进 `failed` 带原因，不阻断专题 | 沿用一期 DEGRADE 思路，状态机扩展 |
| **气隙 + 审计** | 每次模型出站先经 OfflineGuard 授权并入审计 | ASR/VLM/Embedding 端点全部进白名单逻辑 |

---

## 2. 数据模型变更

### 2.1 `Chunk.locator` 扩展（向后兼容）

当前 `Chunk.locator` 仅 `{ page?, paragraph? }`，**不足以承载媒体出处**。扩展为与 `Citation.locator` 对齐，且新增 UI 高亮所需偏移：

```ts
// packages/server/src/domain/types.ts
export interface ChunkLocator {
  page?: number;        // 文档页
  paragraph?: number;   // 文档段（一期已用）
  char_start?: number;  // 新：原文字符偏移（UI 高亮源片段）
  char_end?: number;    // 新
  timecode?: string;    // 新：音/视频时间码，建议 "HH:MM:SS.mmm-HH:MM:SS.mmm"
  bbox?: [number, number, number, number]; // 新：图像/视频帧区域 [x,y,w,h] 归一化
  speaker?: string;     // 新：说话人标签（diarization）
  frame?: number;       // 新：视频帧号（可选）
}
export interface Chunk {
  chunk_id: string;
  material_id: string;
  modality: Modality;   // 新：chunk 自带模态（取代 chunkToCitation 里硬编码 "doc"）
  locator: ChunkLocator;
  text: string;         // 文本/转写/配文/OCR 文本——content_hash 与 BM25/embedding 的对象
  content_hash: string; // sha256(text)，溯源校验对象，永远对"可引用原文"算
}
```

- **兼容**：所有字段可选，旧文档 chunk（无新字段）照常工作。`modality` 缺省视为 `"doc"`。
- **content_hash 不变量**：始终对**可被引用、可被人核对的文本**计算。媒体里即"这段转写/这条配文/这块 OCR 文本"。Contextual-Retrieval 上下文头（若启用）**不进 content_hash**，仅进检索输入。

### 2.2 `Citation.locator` / `chunkToCitation`（**原子提交约束，阻塞项**）

`Citation.locator` 已含 `timecode/bbox`，仅需补 `char_start/char_end/speaker/frame`（与 ChunkLocator 对齐）。`chunkToCitation` **去掉硬编码 `modality:"doc"`**，改用 `chunk.modality`，把 `locator` 整体透传，`confidence` 原样保留。

> ⚠️ **原子性（评审阻塞项）**：`Chunk.modality`、`ChunkLocator` 加宽、`Citation.locator` 加宽、`chunkToCitation` 透传**必须落在同一提交（P2.0）**。否则 `chunkToCitation` 的"locator 整体透传"通不过类型检查（`Citation.locator` 必须是 `ChunkLocator` 的结构超集）。这是整个"media 即另一个 chunk 生产者"成立的承重改动，不是装饰。
>
> ⚠️ 红线核对：`resolveValidCitations` 的 `sha256(chunk.text) === chunk.content_hash` 校验**模态无关**，媒体 chunk 自动适用——这是"chunk 通用单元"成立的关键，无需为媒体写第二套校验。`snippet` 当前取 `text.slice(0,200)`：对转写/配文合适；对**图像/OCR 的 bbox chunk，人核对的是"区域"而非文本**，UI 须按 locator 类型回放（见 §6），不能只靠 snippet。

### 2.3 `Material` 状态机扩展

一期：`pending`（降级）/ `done`（文本）。二期启用完整 `pending → processing → done | failed`：

- `pending`：已汇入、原始落 `materials/`，等待加工。
- `processing`：媒体 job 运行中（ASR/VLM 调用）。
- `done`：产出 `processed/<id>.chunks.jsonl`（+ 模态特定中间产物，见 §4.4）。
- `failed`：加工失败（模型未配置 / 调用错误 / 文件损坏），`note` 记原因，不阻断专题。

`Material` 增补可选字段：`duration?`（音视频秒数）、`processed_at?`、`engine?`（实际所用 ASR/VLM 引擎名，审计/复核用）。

### 2.4 落盘布局（沿用 `cases/<id>/`，新增中间产物）

```
cases/<id>/
  materials/<mid>-<filename>            原始素材（一期已有）
  processed/<mid>.txt                   文档归一化全文（一期已有；媒体可选写"全转写/全配文"）
  processed/<mid>.chunks.jsonl          统一切块（所有模态，一期格式，加 modality/locator 字段）
  processed/<mid>.media.json            新：媒体加工原始结果（ASR 段+说话人 / 分镜+配文 / OCR），可重建 chunks、供复核与回放
  processed/<mid>.frames/<t>.jpg        新：视频/图像关键帧（bbox 引用回放所需，见 §4.3）
  index/<mid>.vec                       新（P2.4+）：稠密向量 blob；**头部带 {embed_model, dim, count}** 版本戳（§5.3）
  ...（manifest/inquiries/elements/report/audit.log 不变）
```

- `.media.json` 是**可审计的中间证据**：UI 点引用跳转到 `timecode`/`bbox` 时回放用，也让加工可复算（重切块不重跑模型）。
- `.vec` 缓存非权威，可随时由 chunks + embedding 重建；**读时校验版本戳**（§5.3）。
- **提交点顺序（评审，承 §7.2 思路）**：媒体加工必须**先把 `.chunks.jsonl`（+ `.media.json` + `.frames`）完整写盘（临时文件 → rename），再翻 manifest 状态为 `done`，最后 append 审计**。因为 `loadCaseChunks` 以 `status==="done"` 为准且**对缺失 chunks 文件吞 ENOENT**——若先翻 done 再写 chunks，并发问答会读到一个"done 但零 chunk"的素材而静默漏料。

### 2.5 重加工 / 重汇入 → Citation 失效规则（**评审阻塞项**）

`process`/重 `process` 会**重写 `.chunks.jsonl`**。若 chunk 文本变化，其 `content_hash` 改变，而 `inquiries.jsonl` / `elements.json` 里**已持久化的 Citation 只在生成时对当时检索集校验过、之后永不复检**——历史结论的引用会**静默失效**（复核员打开旧问答，引用已对不上 hash）。

**定规则（本期采用 a）**：

- **(a) 重加工生成全新 `chunk_id`（推荐）**：重 `process` 视为新版本，chunk_id 用新前缀（如 `<mid>.v2#<idx>`），旧 chunks 保留或归档；旧 Citation 仍指向旧 chunk（hash 仍一致）→ 不失效。新问答用新 chunk。代价：可能并存两版切块，需在 `loadCaseChunks` 选"当前版本"。
- (b) 一旦该素材已被任何 inquiry/element 引用，则**禁止重加工**（返回 409，提示先归档相关结论）。
- (c) 重加工后**标记依赖结论为"源已变更，待重核"**（需扫 inquiries/elements 找引用，较重）。

> 实施时在 Plan 里明确选定并测试。**默认 (a)**：最小惊扰、不破历史溯源。

---

## 3. 模型适配器槽（pluggable model slots）

### 3.1 现状

仅文本 LLM：core `createModelAdapter({provider:"openai-compatible", model, baseURL, apiKey})` → `adapter.generate({systemPrompt, messages, tools, temperature, maxTokens, signal})`。配置经 `readModelConfig()` 读 `MINI_AGENT_MODEL/API_KEY/BASE_URL`，host 进 OfflineGuard 白名单。`LlmDeps{adapter, guard, modelEndpoint}` 注入问答/要素。

### 3.2 新增槽（统一形态）

每个槽 = **接口 + 配置 + OfflineGuard 端点**，mock 实现先行。建议放 `packages/server/src/model/`：

| 槽 | 接口（建议） | 输入→输出 | 真实候选（见记忆/architecture.html） |
| --- | --- | --- | --- |
| **Embedding** | `embed(texts: string[]): Promise<Float32Array[]>` | 文本批 → 向量批 | Qwen3-Embedding-0.6B（Apache，CPU 可跑，1024 维 MRL 可截） |
| **Reranker** | `rerank(query, candidates: string[]): Promise<number[]>` | 查询+候选 → 分数 | Qwen3-Reranker-0.6B（Apache，可选/门控） |
| **ASR** | `transcribe(audio, opts): Promise<AsrResult>` | 音频 → 段[{start,end,speaker,text}] | FunASR 链：fsmn-vad + SenseVoice/Fun-ASR-Nano/Qwen3-ASR-1.7B + cam++（**已选定**） |
| **VLM/Caption** | `caption(frames, opts): Promise<string>` | 帧 → 配文/理解文本 | MiniCPM-V 4.5（端侧）/ Qwen3-VL（时间码 grounding 强） |
| **OCR** | `ocr(image): Promise<OcrResult>` | 图 → [{text,bbox}] | PaddleOCR 等 |

- **配置**：每槽独立 env（如 `MINI_AGENT_ASR_BASE_URL/MODEL/API_KEY`、`MINI_AGENT_EMBED_*` 等），缺失即该槽"未配置"→相关加工降级 `failed` 带提示，不影响其他槽。
- **OfflineGuard**：app 启动时把**所有已配置槽的 host** 合并进白名单；每次调用前 `guard.authorize(endpoint, {user, purpose})`（purpose 如 `asr-transcribe`/`vlm-caption`/`embed-index`）。
  > ⚠️ **诚实边界（评审）**：`authorize` **只校验 host、不校验 purpose**。因此保证是**主机级而非槽级**——若 ASR 与文本 LLM 共用同一本地推理服务 host，则"embed 槽未配置"并不能阻止对该 host 的出站（host 已被另一槽放行）。准确表述应为：**"未配置槽不会新增任何可达 host"**；共享 host 的槽共享信任。如需槽级隔离，再扩 `authorize` 绑定 purpose→host 对。
- **mock-first**：每槽提供 `MockXxxAdapter`（确定性输出，供测试与骨架联调），由配置/环境开关选择 mock vs real。

### 3.3 ASR 适配器细化（FunASR，已选定）

`AsrResult` 形态贴合 FunASR 输出，承载溯源所需：

```ts
interface AsrSegment { start: number; end: number; speaker?: string; text: string; }
interface AsrResult { language?: string; duration: number; segments: AsrSegment[]; }
```

- FunASR 一行端到端（`fsmn-vad` + ASR 引擎槽 + `spk_model="cam++"`）原生给"段+说话人+时间戳"，直接映射 `AsrSegment`。
- **引擎热插拔**：`MINI_AGENT_ASR_MODEL ∈ {SenseVoiceSmall, Fun-ASR-Nano-2512, Qwen3-ASR-1.7B}`。先 SenseVoice 跑通，需更高中文精度/证据级时间戳再换 Qwen3-ASR-1.7B 或评估 FireRedASR2-AED。
- ⚠️ **命名坑（写进配置注释）**：`Qwen3-ASR-Flash` 是闭源 API，气隙不可用；只用开源 `Qwen3-ASR-0.6B/1.7B`。
- 部署形态：FunASR 多为 Python 服务；建议以**本地 HTTP 端点**（openai-compatible / 自定义 JSON）暴露，server 经适配器调用——保持 Node 侧零 Python 依赖、且统一过 OfflineGuard。

---

## 4. 多模态入库管线

### 4.1 汇入与加工分离（关键变更）

一期 `ingest` 对文档**同步切块**。媒体加工慢（ASR/VLM 秒级~分钟级），必须**异步**：

```
ingest(fast)：原始落 materials/，文档→同步切块 done；媒体→status=pending，立即返回
   ↓
process job：媒体素材逐个 pending→processing→（模态管线）→写 chunks.jsonl→done | failed
```

**触发方式**（二选一，建议先 B 再加 A）：
- **B. 显式（先做）**：新增 `POST /api/cases/:id/materials/:mid/process` 手动触发（便于调试/重试），UI"加工/重试"按钮。
- **A. 自动（随后）**：ingest 后对 media 素材入内存队列，后台 worker 串行处理（单机、低算力，串行避免抢占）。

> ⚠️ **manifest 写入串行化（评审阻塞项，异步加工前必做）**：当前只有**审计链**走单写者串行队列；`CaseService.attachMaterial`/`writeManifest` 是**无串行的 read-modify-write**。一旦引入后台 worker（或两次并发 `process`、或 `process` 撞上并发 `ingest`），两次 RMW 会**last-writer-wins 覆盖**导致丢素材/丢状态转移——直接威胁素材/审计不变量。**必须先把所有 manifest 变更接入 per-case 串行队列**（core 已有 `packages/core/src/tools/file-mutation-queue.ts`，一期方案 §line114 本就说复用，只是没接到 `CaseService`）。这是 P2.3 的**第一项**，先于任何 worker。
>
> **崩溃恢复**：worker 在 ASR 途中崩溃会留下永久 `processing` 的素材（`loadCaseChunks` 只读 `done` → 它隐身且无法经"failed→重试"UI 回收）。**启动时扫 `processing` → 改 `failed`（或 `pending`）并记 note**；或令 `process` 幂等、允许从 `processing` 重触发。
>
> 加工状态变更落审计（`material.process` start/done/fail）。

### 4.2 音频管线（FunASR）

```
audio file → fsmn-vad 切段 → ASR 槽转写(+cam++说话人) → AsrResult
  → 每段映射为 Chunk{ modality:"audio", text:段文本,
       locator:{ timecode:"start-end", speaker }, content_hash:sha256(text) }
  → 写 processed/<mid>.media.json（原始段）+ processed/<mid>.chunks.jsonl
  → status=done, material.duration/engine 记录
```

切块粒度：**按 ASR 段（utterance）**即天然引用单元（一句话+时间码+说话人），无需再切。过长段可二次按句切但保持时间码区间。

### 4.3 视频管线（入库预处理，非查询时现场喂 VLM）

```
video → demux(ffmpeg) 出 视频流+音轨
  ├─ 分镜(TransNetV2) → 镜头[t1,t2] → 关键帧
  │     └─ VLM 配文每镜头 → Chunk{ modality:"video", text:配文, locator:{timecode:"t1-t2"} }
  ├─ 音轨 → 走 §4.2 音频管线 → Chunk{ modality:"video", locator:{timecode,speaker} }（转写）
  └─ 关键帧 OCR → Chunk{ modality:"video", text:OCR, locator:{timecode, bbox} }
  → 全部 content_hash + 写 media.json/chunks.jsonl → done
```

**帧存储（评审补）**：分镜关键帧落 `processed/<mid>.frames/<t>.jpg`，并提供取帧端点（如 `GET /api/materials/:mid/frame?t=<timecode>`），否则 `bbox` 引用**无法被人核对**（UI 要在帧上框选区域）。OCR/配文 chunk 的 `locator.timecode/frame/bbox` 指向该帧。

**架构理由**（写入决策记录）：现场把整段长视频喂 VLM 会（1）无法可靠给每条结论精确时间码（违背溯源），（2）长视频推理极贵（如 omni 模型 78–145GB 显存）不可每查询重算，（3）无索引复用。预处理把重算力摊到入库一次，并使时间码引用成为**结构性可验证工件**。可选保留"查询时只对检索命中的少数帧做 VLM 复核"（B-lite），但非默认。

### 4.4 图像管线

```
image → VLM 配文 + OCR → Chunk{ modality:"image", text:配文/OCR, locator:{bbox} } → done
```

### 4.5 失败与降级

- 槽未配置 → `failed`，note=`"音频转写未配置：设置 MINI_AGENT_ASR_*"`（沿用一期 DEGRADE 文案风格）。
- 模型调用异常 → `failed` + note，保留原始素材，可 `process` 重试。
- 部分成功（如视频 VLM 成功但 OCR 失败）→ 仍 `done`，已成功的 chunk 入库，note 记部分失败。
- **幂等**：重 `process`（含部分失败重试）必须**替换而非追加** chunks（否则重复入库）；配合 §2.5 的 chunk_id 版本化。

### 4.6 真实媒体上传（**评审阻塞项**）

当前汇入是 **base64 内联进 JSON**（`material-service.ts`），且 `express.json({limit:"25mb"})`——25MB JSON 体经 base64 膨胀后 ≈ **18MB 原始文件**。真实音视频动辄 100MB–GB，**现路径直接撞墙**。二期媒体必须改：

- 媒体走**多部分/流式上传**（`multipart/form-data` 或分片上传到 `materials/`），绕开 JSON 体积上限与 base64 膨胀；文本/小文件可保留现 base64 路径。
- 选型保持少依赖：可用 Node 原生 `req` 流 + 边界解析，或一个轻量 multipart 解析（评审实施时定）；落盘仍是 `materials/<mid>-<filename>`，下游不变。
- 这是 P2.3a 的前置（音频文件就可能超 25MB）。

---

## 5. RAG 检索升级

### 5.1 token 预算路由（替换 §7.3 "必检索"）

`InquiryService.ask`（及要素抽取的取材）改为：

```
budget = ctxWindow(模型) − reserve(系统提示+问题+答案)   // 经配置，取窗口 ~50–60%
chunks = loadCaseChunks(caseId)
if estTokens(chunks) ≤ budget:
    used = chunks                       // 全上下文：所有 chunk 进，retrievedById=全集
else:
    used = retrieveHybrid(q, chunks)    // 检索路：见 §5.2
→ 喂模型（带 chunk_id）→ 校验引用（两路同一 resolveValidCitations）
```

- **全上下文模式**：`retrievedById` = 全部 chunk，模型引用任意 chunk_id 都能校验 → **零检索召回风险**，直接化解"RAG 压制质量"。
- **拒答阶梯不变（评审）**：现 `ask()` 有三条 insufficient 路径——① 专题无任何 chunk；② 模型返回 `insufficient`；③ **所有 claim 过不了 `resolveValidCitations`（`verified.length===0`）**。全上下文下第①条的 `hits.length===0` 判据改为"专题零 chunk"，但**第③条才是全上下文下守住红线的关键**，逻辑原样保留。
- **诚实边界重申**：全上下文下所有 chunk 在场，模型更可能引用"看似相关但并不支撑"的 chunk（hash 仍过、但一期已声明的"绑定≠蕴含"逻辑落差变宽）→ 仍由人工复核兜底。
- **`estTokens` 必须 fail-safe（评审）**：字符粗估（中文≈字符、英文≈chars/4）误差可达 2×，且**低估 → 撑爆真实窗口 → 模型中途截断/报错**（不对称风险）。对策：① 预留充分（窗口 ~50–60%）；② **近边界（如已达预算 80%）即走检索路**，宁可 top-k 也不冒险塞满；③ 估算须计入 `callModel` 每 chunk 的 `[chunk_id] ` 框架开销（现实现每片段加此前缀）。
- **预算配置 opt-in（评审）**：`MINI_AGENT_CTX_BUDGET_TOKENS` **不设默认**——未设时退回一期 BM25 top-6（部署模型未知前，一个过高的默认会在生产静默撑爆生成）。
- **与要素抽取 `MAX_CHUNKS=60` 协调（评审）**：`element-service.ts` 已有独立的 `MAX_CHUNKS=60` 静默截断。P2.1 须明确：预算路由**取代**该截断，还是叠加？若叠加，60-chunk 专题可能一边报"全上下文"一边静默丢块。建议预算路由统一取代之。

### 5.2 检索路：混合 + RRF + 可选重排

```
BM25(已有 retrieve) → top-N_bm25
dense: embed(query) vs 素材向量 → top-N_dense       // 向量见 §5.3
RRF 融合(k=60)：score = Σ 1/(60 + rank_i) → top-N
[可选] Reranker(query, top-N 文本) → 重排 top-k       // 按候选数/规模门控
→ used = top-k
```

- **RRF 零依赖**（约 20 行），融合排名而非分数，规避 BM25/cosine 量纲不可比。
- Embedding 未配置时**自动退化为 BM25-only**（dense 分支跳过），不阻断。
- Reranker 默认关，`MINI_AGENT_RERANK_*` 配置且候选数超阈值才开。

### 5.3 向量存储（分层，零/少依赖）

| 范围 | 存储 | 理由 |
| --- | --- | --- |
| 单专题 | **进程内暴力余弦**（读 `index/<mid>.vec` Float32 blob） | 精确（不漏匹配，对溯源关键）、零依赖、毫秒级（≤约 5–10 万块） |
| 跨专题知识库 | **sqlite-vec**（纯 C、单文件、SIMD 精确 KNN，vendor 预编译二进制） | 单文件、气隙可装、`vec0` 精确扫描 |

- 入库加工时顺带 `embed(chunk.texts)` 写 `index/<mid>.vec`（与 chunks.jsonl 同序）。embedding 未配置则不写，检索退 BM25-only。
- **版本戳（评审）**：`.vec` 头部记 `{embed_model, dim, count}`。**读时若与当前 embed 配置不符（换模型/维度变）→ 忽略该 `.vec`、退 BM25-only 并标"待重建索引"**——否则维度不匹配会抛错或算出垃圾相似度。`count` 与 chunks 数对不上（重切块未重嵌）亦视为失效。**`.vec` 重建须与 `.chunks.jsonl` 写入同一提交**，避免位置错位（向量映射到错的 chunk → 错引用）。
- **精确优先于 ANN**：溯源系统不接受索引悄悄丢掉那一个匹配块；规模逼近上限再评估 ANN（高 recall 参数 + 过取回重排兜底）。

### 5.4 切块策略（配合溯源粒度）

- 文档：结构感知（标题→段落→句），存 `char_start/char_end`（UI 高亮）。可选**父子粒度**：引用指向小块（精确 hash），喂模型用父块（足够上下文）。
- 媒体：音频按 ASR 段、视频按镜头/段、图像按区域——天然小粒度可引用。
- 可选 Contextual-Retrieval 头（入库时本地 LLM 给每块加一句上下文再索引）：**头只进 embedding/BM25 输入，content_hash 仍对原文算**——别污染可引用内容。

---

## 6. 红线集成（不变 + 扩展点）

| 红线 | 二期影响 | 动作 |
| --- | --- | --- |
| **Citation 溯源** | 媒体 chunk 自动适用（hash 校验模态无关） | 仅 `chunkToCitation` 去硬编码 modality；UI 按 locator 类型跳转（段/时间码/bbox） |
| **零外发 OfflineGuard** | 新增 ASR/VLM/Embedding/Rerank 出站 | 已配置槽 host 进白名单；每次调用前 authorize（purpose 区分）；未配置槽天然不放行 |
| **审计哈希链** | 新增动作 | `material.process`(start/done/fail)、`egress.allow/deny`（各模型端点）、`embedding.index`、`media.engine`（记实际引擎，复核用）。链结构不变 |

**媒体 content_hash 的诚实边界（评审，重要）**：文档 chunk 的 `sha256(text)` 可对**人能打开的原文件**复核；ASR 转写的 `sha256(transcript)` 只证明"转写后未被篡改"，**不证明转写忠实于音频**。红线含义从"引用可核对的源文本"**微弱降级**为"引用模型对源的可能有误的渲染"——这是**固有且可接受**的，但必须像一期"绑定≠蕴含"一样**明确声明**：媒体引用绑定的是**转写/配文**，其保真度属人工复核范畴。缓解=`.media.json` + 时间码回放，使复核员能**回听/回看被引用的那一段**。→ "复核员可回放被引用片段"是 P2.3 的**硬验收**，非 UI 点缀。

UI 溯源跳转（§7.3 末"绑定≠蕴含"诚实边界不变）：
- `paragraph/char` → 文档高亮片段
- `timecode` → 音/视频跳播到区间（+ speaker 标签）→ **可回听/回看原片**
- `bbox` → 图像/帧框选区域（取 `processed/<mid>.frames/<t>.jpg`）

---

## 7. 配置总览（env，全可选，缺失即降级）

```
# 文本 LLM（一期已有）
MINI_AGENT_MODEL / MINI_AGENT_API_KEY / MINI_AGENT_BASE_URL
# RAG
MINI_AGENT_CTX_BUDGET_TOKENS         # 全上下文阈值（随部署模型设定）
MINI_AGENT_EMBED_BASE_URL / _MODEL / _API_KEY
MINI_AGENT_RERANK_BASE_URL / _MODEL / _API_KEY   # 可选
MINI_AGENT_RERANK_MIN_CANDIDATES     # 重排门控：候选数 ≥ 此值才精排（默认 8；有效上限 24=过取回深度）
# 媒体
MINI_AGENT_ASR_BASE_URL / _MODEL / _API_KEY      # FunASR 端点；MODEL∈SenseVoiceSmall|Fun-ASR-Nano-2512|Qwen3-ASR-1.7B
MINI_AGENT_VLM_BASE_URL / _MODEL / _API_KEY      # MiniCPM-V 4.5 / Qwen3-VL
MINI_AGENT_OCR_BASE_URL / _MODEL / _API_KEY
# 开发：未配置时是否用 mock 适配器（默认 false=降级 failed）
MINI_AGENT_USE_MOCK_MEDIA=true
```

API key 一律**只在 shell env、不落盘/不入审计/不回前端**（沿用一期）。

---

## 8. 待决策（交评审/用户确认）

1. **媒体加工触发**：先做显式 `POST .../process`（可控、易测）还是直接上自动后台队列？（建议：显式优先，队列随后）
2. **token 预算默认值**：评审定**不设默认、opt-in**（未配置退一期 BM25 top-6），见 §5.1。待用户确认。
3. **Python 边界**：FunASR/VLM/OCR 多为 Python。统一以**本地 HTTP 端点**接入（保持 Node 零 Python 依赖、统一过 OfflineGuard）——确认这是部署方接受的形态。
4. **知识库（跨专题）范围**：评审建议**默认留三期**——二期只做专题内多模态 + 预算路由 + 进程内稠密检索；sqlite-vec 跨专题 KB 不在本期。待确认。
5. **Contextual-Retrieval 头 / 父子切块（§5.4）**：评审建议**默认留三期**——每块多一次本地 LLM 入库开销、收益未证；待检索质量不足再加。待确认。
6. **重加工失效规则**：§2.5 默认采 (a) 新 chunk_id 版本化。待确认。

---

## 9. 与一期文档的关系

- 不替代 `intel-workbench-product-spec.md`（产品/界面）与 `intel-workbench-phase1-engineering-plan.md`（一期工程）；本文是其**二期延伸**，§编号自成体系，复用一期的 §4.3 Citation 契约、§7.1 OfflineGuard、§7.2 审计链、§7.3 问答管线。
- 实施顺序、里程碑、验收标准见配套《二期工程方案》。
