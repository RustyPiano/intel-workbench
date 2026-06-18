# 开发交接文档（intel-workbench / 离线情报分析工作台）

> 给接手开发的 Agent / 工程师。读完这份 + `CLAUDE.md`（行为准则）+ `docs/specs/` 就能上手。
> 最后更新：2026-06-18（P3.D 五个模型槽接真收官）。当前分支 `feat/intel-p3-harness`。

---

## 0. 一句话

面向情报部门的**离线、气隙（air-gapped）**智能情报处理与多模态分析系统。本地 web 应用，monorepo `packages/{core,server,web}`。给非技术情报人员用的 GUI；摄入异构材料（文档/音频/图像/视频）→ 解析/转写/识别 → 切块 → 语义检索 → **带逐条溯源的问答** → 通报。**所有模型可换本地端点，零外发**。

---

## 1. 现在到哪一步了（state）

**已完成并合入 `feat/intel-p3-harness`：**
- **P3.B 全部**（流式问答会话面、多模态按需工具、可编辑版本化提示词，前后端）。
- **P3.doc**：PDF/Office 真解析（接本地 `lit`/liteparse，页级 chunk）。
- **P3.ocr**：OCR 接本地 PaddleOCR（扫描件兜底）。
- **P3.D 五个模型槽全部接真**（本次）：

| 槽 | 接入 | 端点 | 提交 |
|---|---|---|---|
| 文本 LLM | DeepSeek（开发替身，OpenAI 兼容） | `api.deepseek.com/v1` | (既有) |
| OCR | 本地 PaddleOCR | `127.0.0.1:8000` | ac34239 / 65b8cbb |
| Embed | 硅基流动 Qwen3-Embedding-8B（4096维） | `api.siliconflow.cn/v1` | df6892d |
| Rerank | 硅基流动 Qwen3-Reranker-8B | 同上 | a453726 |
| VLM | 硅基流动 Qwen3-VL-32B-Instruct | 同上 | 97c5417 |
| ASR | 本地 FunASR（VAD+ASR+标点+cam++，带时间戳/说话人） | 127.0.0.1:8001 | c5d8522 |

**端到端真能跑**：文本问答 · 向量语义检索 · 重排 · 文档/扫描件 OCR · 图像/视频帧理解 · 语音转写。每个模型槽都经过 **接真→对抗评审→修复→真链路 live e2e 亲验→提交**。

**门禁**：`npm run check` 本地 **546 passed / 2 skipped** 绿，typecheck 干净。

---

## 2. 三条红线（不变量，绝不可破）

任何改动必须守住这三条；**对抗评审最常抓的就是红线回归**（本次 Embed 接真就被双评审抓到摄入路径漏授权）。

1. **零外发（zero-egress）**：每一次模型出站（文本 LLM / 各槽）**必须先过 `OfflineGuard.authorize(endpoint, {user,purpose})`**，再发网络请求。`offline-guard.ts` 是调用前置闸（不是 fetch 拦截器），deny → 写 `egress.deny` 审计 + 抛 403。
   - 适配器内部**不写** authorize；由调用方在出站前完成（与文本 LLM 一致）。
   - **不变量：真槽 ⟺ 非空端点 ⟺ host 在白名单**（都从 `slotConfigs.<slot>.configured` 派生，见 `app.ts` 注释）。空端点（mock/未配置）天然跳过授权。
   - 出站点清单（全部已 gated）：摄入 `material-service.ts` `process()`（media-ingest）+ `writeIndex`（embed-ingest）+ 扫描件（doc-ocr）；查询 `inquiry-service.ts`（embed-query / rerank-query）；按需工具 `intel-harness.ts`（asr/vlm/ocr）。**新增任何模型出站，必须配一条 authorize。**
2. **引用溯源**：每个 chunk `content_hash = sha256(chunk.text)`；引用解析 `citation.ts` 强制 `sha256(chunk.text)===content_hash` 才放行。问答答案只能从 finalize + ledger 生成。
3. **审计哈希链**：`audit-service.ts` 追加式 + `payload_hash`/`prev_hash`/`event_hash` 链；`verify()` 可验篡改。单写者队列。

---

## 3. 怎么跑 / 怎么测

> 完整「运行整个项目」分步指南见 **[docs/how-to/run-the-workbench.md](how-to/run-the-workbench.md)**。速记：

```bash
# 1) 填两把 key（仅本机，已 gitignore，绝不入库）
#    dev.env.sh 里：SILICONFLOW_API_KEY（Embed/Rerank/VLM）+ DEEPSEEK_API_KEY（ASR 走本地 FunASR，无需 key）
source dev.env.sh

# 2) 本地模型服务（独立 uv 项目，不在本仓库；测 OCR / 语音时各自起）
cd ../paddleocr && uv run python server.py   # OCR → 127.0.0.1:8000
cd ../funasr   && uv run python server.py    # ASR → 127.0.0.1:8001（首次联网拉 ~2GB 模型，之后离线）

# 3) 起工作台
npm run dev:server      # 后端 :4319
npm run dev:web         # 前端（Vite 代理 /api → :4319）

# 4) 全量测试 + typecheck（hermetic，不连真模型）
npm run check           # = typecheck + vitest run
```

- **API key 红线**：只放 `dev.env.sh`（gitignored）/ shell env，**绝不落盘到仓库、不入审计、不回前端、不进 commit**。
- **2 个 skip 是环境性假失败**（`api.test.ts` 需 TCP、`bash.test.ts` 偶发），不是真问题。**Codex 沙箱里 vitest 会因 TCP 受限假失败 → 任何里程碑判定都以本地 `npm run check` 为准**。
- env 全清单见 `dev.env.sh`（非密值已填好：端点/模型/维度）。

---

## 4. 架构速览

```
packages/
  core/    通用 agent 运行时（与情报域解耦）：runtime/{loop,agent,prompt}.ts、
           model/openai-compatible.ts（文本 LLM 适配器 + stream()）、tools/
  server/  情报域后端（Express）：见下方文件地图
  web/     React 19 + Vite + TS 严格；CaseWorkbench.tsx（5 个面板）、api.ts、App.tsx
```

**数据层 = 文件即库（零 DB，刻意，气隙友好）**：
```
cases/<id>/
  manifest.json            专题元数据 + 材料清单
  materials/               原始上传字节
  processed/<mid>.txt      展示用纯文本
  processed/<mid>.chunks.jsonl   切块（chunk_id/locator/text/content_hash）
  processed/<mid>.media.json     媒体加工产物（帧/转写/OCR）
  index/<mid>.vec          稠密向量（版本戳 {embed_model,dim,count}，可重建缓存）
  inquiries.jsonl          问答记录（流式）
  elements.json            结构化实体抽取（person/org/location/event/equipment/time + aliases）
  report/                  通报状态机 + 渲染产物
audit/audit.jsonl          全局审计哈希链
config/{users.json, prompts/}   用户、受管系统提示词（可编辑+版本归档）
```
> 注：`packages/server/{cases,audit,config}/` 是运行时落盘产物，**不要提交**（根 `.gitignore` 用 `/cases/` 等根锚定忽略；server 下同名目录目前未忽略，是已知小账，勿误提交）。

---

## 5. 模型槽 = 扩展点（怎么加/换一个真模型）

接口在 `packages/server/src/model/slots.ts`：`ModelSlots = {asr,vlm,ocr,embed,rerank}`，每个是一个适配器接口或 `null`。文本 LLM 是**另一条路**（`model-config.ts` + core `OpenAICompatibleModelAdapter`，非 slots）。

**加一个真适配器的同形套路（5 个已接的就是模板）：**
1. 写适配器类 `model/cloud-<x>.ts` 实现对应接口（`fetch` 打端点 + 一个**纯映射函数**便于单测，fail-closed）。模板：
   - `cloud-embed.ts`（OpenAI `/embeddings`，自动分批 + 按 index 还原序）
   - `cloud-rerank.ts`（Jina/Cohere 式 `/rerank`，按 index 回填**原序**）
   - `cloud-vlm.ts`（多模态 `/chat/completions`，data URL 送帧 + MIME 嗅探）
   - `cloud-asr.ts`（云 multipart `/audio/transcriptions`，只返文本）/ `funasr-adapter.ts`（本地 FunASR `/asr`，富响应带时间戳+说话人，`MINI_AGENT_ASR_PROVIDER=funasr` 选用）
   - `paddle-ocr.ts`（本地 PaddleOCR）
2. `mock-slots.ts` 的 `buildSlots()` 把该槽分支改为 `configs?.<slot>.configured ? new Cloud<X>Adapter(...) : mockEnabled ? new Mock<X>() : null`。
3. **配授权**：确认该槽出站点前有 `authorizeMedia(actor,[endpoint],"<purpose>")`（摄入侧）或 `guard.authorize`（查询侧）。**摄入侧若是新出站点要补**（Embed 接真时 `writeIndex` 就漏了，被评审抓到 → 补 `embed-ingest` 授权 + 串 `actor`）。端点经 `app.ts` 从 `slotConfigs.<slot>.configured?baseURL:""` 注入。
4. 写 hermetic 单测（mock fetch + 纯映射函数）+ 在 `slots.test.ts` 加 real/mock/null 三态。
5. 本地 `npm run check` 绿 → 用真端点跑一次 live e2e（临时 test 文件，跑完即删，key 走 env 不落盘）→ 提交。

**env 约定**：`MINI_AGENT_{ASR,VLM,OCR,EMBED,RERANK}_{BASE_URL,MODEL,API_KEY}`（baseURL 含 `/v1`）；Embed 另需 `_DIM`（=模型输出维度，缺则构造期 fail-fast，对齐 `.vec` 版本戳）。文本 LLM：`MINI_AGENT_{MODEL,BASE_URL,API_KEY}`。

**部署（气隙机）**：把各 `*_BASE_URL` 换成本地端点即可（开源模型方向见提交历史/spec：ASR 本地 FunASR+cam++ 补 speaker、VLM 本地 MiniCPM-V/Qwen-VL）。

---

## 6. 开发工作流（本项目约定）

- **总架构师（Opus）拆规格 → 实现 → 对抗式评审（独立、给 file:line 证据）→ 裁决（跨模型分歧常=真问题）→ 修复 → 循环至无阻塞 → 本地 `npm run check` 绿 → 提交 → 下一里程碑。** 大实现可派 Codex（`codex:codex-rescue` 子代理），小手术自己改。
- **红线面用双/多评审**；纯前端无红线面可单评审。
- **提交**：中文 conventional commit，scope 如 `intel-p3.d`；trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。只在功能完成且本地 check 绿后提交；在 feature 分支上做。
- **simplicity-first / 外科手术式改动**（见 `CLAUDE.md`）：最小改动、只清自己的 orphan、匹配既有风格、不加投机抽象。

---

## 7. 文件地图（server 关键路径）

| 区域 | 文件 |
|---|---|
| 模型槽接口 / 配置 / 工厂 | `model/slots.ts`、`model/slot-config.ts`、`model/model-config.ts`、`model/mock-slots.ts` |
| 真适配器 | `model/{paddle-ocr,cloud-embed,cloud-rerank,cloud-vlm,cloud-asr,funasr-adapter}.ts` |
| 摄入 / 媒体 / 文档 / 向量 | `materials/{material-service,media-pipeline,doc-parser,vec-store}.ts` |
| 问答 / 检索 / 引用 / harness | `inquiry/{inquiry-service,retrieval,citation,intel-harness}.ts` |
| 安全 / 审计 | `security/{offline-guard,guarded-adapter}.ts`、`audit/audit-service.ts` |
| 提示词 / 管理 | `admin/{prompt-store,admin-service}.ts` |
| 路由 / 装配 | `routes/*.ts`、`app.ts` |
| 前端 | web `pages/CaseWorkbench.tsx`（materials/elements/inquiry/report/audit 面板）、`api.ts`、`App.tsx` |

deeper：`docs/specs/intel-workbench-phase3-agent-harness-plan.md`、`...product-spec.md`、`...phase2-multimodal-rag-spec.md`；架构图 `docs/architecture.html`。

---

## 8. 已知短板 / 待办（deferred）

- **NewCase 向导上传是假 dropzone**（`handleAddMockFile` 只塞 state）；真上传在工作台 MaterialsPanel（`uploadMaterial` 流式直传 `/materials/upload`）。→ 接真或去占位。
- **无跨专题（跨案件）数据总览面板**——目前严格单案件。回应"数据管理而非一次性应用"。
- **ASR 现用本地 FunASR**（VAD+ASR+标点+cam++，:8001）：句级时间戳 + 说话人标签已恢复；云 `CloudAsrAdapter` 经 `MINI_AGENT_ASR_PROVIDER` 一键切回。⚠️ cam++ 说话人分离在合成 TTS 双声测试上聚为单一说话人——真实多说话人录音上的分离待验证/调阈，未过度声称。paraformer-zh 是中文模型（英文音频转写偏差）。
- **视频抽帧/分镜仍是 mock**（VLM 现按单帧 caption；真分镜=部署期本地层）。
- 角色/权限系统（operator/admin/security + 密级层级）连贯但偏粗，rationale 待显性化。
- 其它：扫描件 bbox 行级高亮、per-tool 审计 runId、P3.A-local 本地 LLM tool-calling 冒烟、B-2 符号链接 realpath 加固。

---

## 9. 大目标 / 评分导向（务必理解，决定取舍）

老师（2026-06-18 明确，关注 **创新性 / 工作量 / 规范性**）：自研能力要**赢"大模型直出"和别人的 skill、非套壳**；任务**具体且属情报域**（例：军舰轨迹统计；跨文件&文件内同一事实的**交叉验证/矛盾检测**）；要有**benchmark 量化对比**证明非套壳；UI 与用户系统**要有可见的逻辑**。

**架构判断**：目前的 ingest→OCR→RAG→引用→审计 是**"地基"**（任何 RAG 都有，属"通用已有工作"）。**拿分点要上移到地基之上的 1–2 个垂直情报分析 skill**——已设计**首发 = 交叉验证/矛盾检测**：claim 级结构化抽取（带出处）→ 实体归并（复用 `elements.json`）→ 聚类 → **类型感知比较引擎（数值/时间/地理/类别确定性比较 + 自由文本退 NLI）做矛盾判定** → 逐条 provenance 的冲突报告 + UI。配**合成带标注语料 benchmark**（植入已知矛盾 + 难负例）打赢 raw-LLM。**LLM 只是组件，判定算法是我们的 → 这是"非套壳"的硬边界。**

---

## 10. 下一步（用户既定次序）

1. **做好已有功能**（当前阶段）：NewCase 真上传/去占位 · 跨案数据总览面板 · 媒体真链路浏览器验收 · 角色逻辑梳理+说明。
2. **拿分层**：交叉验证/矛盾检测 skill + benchmark（填创新/对比两大空白）+ 架构图/设计说明（让设计可见）。
3. P3.C 多 agent 编排（用户暂缓）。

> 接手提示：动任何模型出站 / 摄入 / 检索路径，先回看**第 2 节红线**；判定里程碑以**本地 `npm run check`** 为准；提交守**第 6 节约定**。
