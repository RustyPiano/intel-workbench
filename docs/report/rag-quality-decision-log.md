# RAG / 工作台检索质量改造——决策与实验记录

> **用途**：留存改造过程中的**决策、根因、选项权衡、验证数据**，供后续写实验报告直接取材，并防止对话压缩后丢失过程（体现工作量与规范性）。
> **范围**：从"上传超时 bug"起，到 RAG 检索质量改造（切块 / bbox / 评测 / Contextual Retrieval / 查询改写）。
> **维护方式**：每完成一个决策或步骤，**追加**一节（背景 → 根因/选项 → 决策 → 理由/权衡 → 验证 → 状态）。**不删旧节**。
> **分支**：`feat/intel-p3-harness`　**起始**：2026-06-18　**最后更新**：2026-06-18

---

## 0. 变更时间线（速览）

| # | 决策/步骤 | 状态 | 关键产出 |
|---|---|---|---|
| D1 | 上传超时 / "解析不可用"误报 → best-effort 索引 | ✅ | embed 失败不再阻断/误报解析；+删除/重建索引/审计接真/上传 UX |
| D2 | "仍报错"真相 = 陈旧素材 → 恢复 | ✅ | 证实修复有效（270 块）；恢复 case 123456 两份 PDF |
| D3 | 切块 53 vs 6 的诊断 | ✅（诊断） | 定位两路切法 + 过碎/过粗 + 检索影响 |
| D4 | 主流 RAG 方案 + 是否套框架 | ✅（决策） | 不套重框架，借鉴具体技术 |
| D5 | OCR 要不要喂 LLM 整理 | ✅（决策） | 不让 LLM 文本成为被引用原文（守溯源红线） |
| D6 | 锁定本轮范围与关键取舍 | ✅（决策） | 5 步计划 + CR 逐块 LLM + verbatim 不变量 |
| D7 | 步骤 1：切块重构（size-target 打包） | ✅ | 75 块 md→3 块；7.1KB/53→~12；554 测试绿 |
| D8 | 步骤 2：bbox 几何重排（OCR） | ⏭️ 下一步（未动代码） | — |
| D9 | 步骤 3：评测 / benchmark 闭环 | ⬜ 待办 | — |
| D10 | 步骤 4：Contextual Retrieval（逐块 LLM） | ⬜ 待办 | — |
| D11 | 步骤 5：查询改写（rewrite/HyDE） | ⬜ 待办 | — |

---

## 0.5 接手须知（current state，2026-06-19，压缩对话后先读这节）

**分支** `feat/intel-p3-harness`。
**状态：D1–D7 的 RAG/工作台改造 + 前端样式已提交为一个检查点（本日志随该提交入库），working tree 应为 clean。** 接手时 `git log` 看最新 `feat(intel-workbench)` 提交、`git status` 确认干净；后续新改动从这里起。下面归属表用于将来想把"功能 vs 纯样式"拆成两个提交或回溯时参考。

**改动归属**（便于后续分提交：RAG/功能 vs 纯样式）：
- **本次 RAG/工作台改造（本人）** — server 全部 + 测试 + `web/src/api.ts`：
  `audit-service.ts`(readCaseEvents)、`cases/case-service.ts`(detachMaterial)、`inquiry/inquiry-service.ts`(查询侧 dense 失败降级 BM25)、`materials/material-service.ts`(best-effort 索引 + `remove` + `reindex` + **切块打包器 `packChunkSpans`**)、`routes/{api,cases}.ts`(delete/reindex/audit 路由)、`tests/{doc-parsing,elements,materials}.test.ts`、`web/src/api.ts`(deleteMaterial/reindexMaterial/listCaseAudit/XHR 上传带进度)。
- **共用文件（本人 + 前端样式 Agent 都改过）**：`web/src/pages/CaseWorkbench.tsx`（本人：删除/重建索引按钮、真审计面板、上传进度/错误 UX、文档 note 横幅；样式 Agent：措辞润色）、`web/src/styles.css`（本人：`@keyframes iw-bar-pulse`；样式 Agent：其余）。
- **仅前端样式 Agent**（非本人，"去 AI 味"）：`web/src/components/TopBar.tsx`、`web/src/pages/{Admin,AuditCenter,CaseList,NewCase}.tsx`。
- **本日志**：`docs/report/rag-quality-decision-log.md`（未跟踪 `??`）。

**验证基线**：`npm run check` = typecheck 干净 + **554 passed / 2 skipped**。改完任何东西重跑此命令（注意：Codex 沙箱 TCP 假失败，以本地 `npm run check` 为准）。

**立即下一步**：D8 bbox 几何重排（见该节，含可冷启动的实现计划）。然后 D9 评测/D10 CR(逐块 LLM)/D11 查询改写。

**存量提醒**：`packages/server/cases/123456` 两份 PDF（270/42 块）是**旧切法**切的；`reindex` 只重嵌不重切，要用上新切块得**重新汇入**（从盘上原件重传，各约 30s）。

---

## D1 — 上传超时 / "PDF/Office 解析暂不可用"误报 → best-effort 稠密索引

**现象**：上传 PDF/Office 卡 ~60s，然后报 `PDF / Office 文档解析暂不可用，待加工（M2 降级）：The operation was aborted due to timeout`，文档完全不可用。

**根因（定位）**：稠密索引 embedding **同步**跑在上传请求里，且与文档解析**共用一个 `try/catch`**：
- dev 期 embed 槽接的是云替身 SiliconFlow（`CloudEmbedAdapter`，`AbortSignal.timeout(60_000)`）。
- 端点不可达时这 60s 把整个上传请求卡死 → 超时抛出 `The operation was aborted due to timeout`。
- 该 embed 失败被 `processDocAtIngest` 的 catch 接住，**误贴成"文档解析不可用（M2 降级）"** 并回退 `pending`。其实 `lit` 早就解析成功、`chunks.jsonl` 已落盘 → **盘上有切块、状态却 `pending` 的脏态**（`loadCaseChunks` 只读 `done` → 文档在问答里"隐身"）。

**选项与权衡**：
- (a) **best-effort inline embed**（吞错不阻断，解析成功即 done）。
- (b) 后台异步索引（上传立即返回，后台建 .vec）。**否决**：破坏 §5.3"`.vec` 与 chunks 同提交"不变量，且 `materials.test.ts:380` 断言 ingest 后 `.vec` **同步存在**，会连带改测试与文档契约。
- (c) 降低全局 `TIMEOUT_MS`。**否决**：查询侧共用该常量，只是失败更快，不解决"误报为解析失败"。

**决策**：采 **(a)**。`writeIndex` 改 best-effort——吞异常 → 落 `material.index` error 审计 → 返回 `{indexed, note}`，**永不抛**；解析成功即 `done`，embed 失败仅挂 note「稠密索引未建（检索回退 BM25，可在素材上「重建索引」）」并经各 writeDocChunks* / `process()` 串到素材 note。查询侧 hybrid 升级也包 `try/catch` → embed 不可达降级 BM25，不让问答整体失败。
- **关键点**：mock embed 进程内同步、永不抛 → `.vec` 仍同提交落盘，§5.3 不变量与单测**不破**；只有真·云端点超时这条路径行为改变。

**同批附带（属"做好已有功能"）**：
- **删除**：`MaterialService.remove`（先 detach manifest 再清 raw/processed/index/frames + 审计）+ `CaseService.detachMaterial` + `DELETE /api/cases/:id/materials/:mid` + UI 删除按钮。
- **重建索引**：`MaterialService.reindex`（读盘 chunks → best-effort 重建 .vec，成功清 note，仅 done 可建）+ `POST .../reindex` + UI 按钮。
- **专题审计接真**：把写死的假 `AUDIT_ROWS` 换成 `AuditService.readCaseEvents`（读 `cases/<id>/audit.log` 镜像）+ `GET /api/cases/:id/audit`（cases.get 校验访问/密级）。
- **上传 UX**：`uploadMaterial` 改 XHR + `upload.onprogress` 真进度条；单文件失败不拖垮整批（收集 `uploadIssues`）；修过时空态文案（PDF/Office 现真解析）。

**验证**：`npm run check` 绿 **554/2**（+3 新测：embed 超时→done+note 不降级 pending / reindex 恢复建 .vec 清 note / remove 清盘+摘除+审计+再删 404）。真 server 亲验：配不可达 embed → 上传 **0s** 返回 `done`+note(`fetch failed`)、`material.index` error 入审计、per-case audit / delete / reindex 端点全通。

**守住的红线**：embed 出站前仍 `authorize`（零外发）；删除/重建落审计；per-case 审计访问受控。

**残留**：embed 端点"可连 TCP 但不响应"时上传仍可能等满 60s（产出仍是可用 done 文档）；真部署用本地 embed=快；未改全局 `TIMEOUT_MS`（查询侧共用）。

---

## D2 — "修了还是报错"的真相 = 陈旧素材，非修复无效

**现象**：用户报修复无效，工作台仍显示 `PDF / Office 文档解析暂不可用（M2 降级）`。

**根因**：`best-effort` 只管**新**摄入，**无法回改修复前已失败落盘的素材**。`cases/123456` 里有两份 PDF 是旧代码失败时写下的陈旧 note（`pending`、零 chunk）。**证实修复有效**：把同一份 PDF 重新上传到运行中的 server → `done`、**270 块**。

**决策/动作**：从盘上原始文件**重新汇入**两份 PDF（新 id → done）→ 再删旧 `pending` 条目（先建后删，无空窗）。case 123456 恢复可用：`s41586…pdf` → done 270 块、`AgentStateBus-立项书.pdf` → done 42 块。

**顺带（UX 诚实化）**：字节传完后还要等服务端 embed（270 块约 30s），旧进度条静默停在 100%。改为：`fraction>=1` 时显示「服务端解析+建索引中…」+ 进度条透明度脉动（`@keyframes iw-bar-pulse`，不缩放免溢出）。

**经验教训（写进报告）**：数据迁移/修复要考虑**存量**；行为修复不等于历史数据自动修复。

---

## D3 — 切块为何"7.1KB/md=53 块、扫描件 PDF=6 块"（诊断）

**现象**：同一份内容，markdown 切 53 块（~134 字/块，过碎），其扫描版 PDF 只切 6 块（过粗）。

**根因（两条不同代码路径 + 朴素切法）**：
- `.md` 走**文本路径**（不调 lit）：`chunkText` 按空行 `/\n\s*\n/` 切，**只拆过长（>1200）、从不合并过短**。markdown 空行密集 → 每个标题/短段各成一块 → 53 块。
- 扫描件走 **OCR 路径**：`r.lines.map(l=>l.text).join("\n")` 用**单 `\n`** 拼接，无空行 → 整页是一个段落 → 每页 ~1 块 → 6 块。
- 即：**切块边界取决于源格式（markdown 空行 vs OCR 行拼接），而非内容** → 同内容两路相反碎裂。

**检索影响**：
- 过碎（53 小块）：短片段嵌入噪声大/概念被拆/BM25 长度归一对短块刷分 → top-k 噪声；但引用精确。
- 过粗（6 页块）：粒度粗、引用指向整页、>1200 处硬切断句。
- 小专题因 **token 预算路由**（`selectContext` full 模式）会把全部 chunk 喂模型、跳过检索 → 影响主要在**摄入耗时**（块越多 embed 越多）+ 专题增大后的排序质量。

**结论**：切块需"目标尺寸打包"（见 D7）。

---

## D4 — 主流 RAG 方案 / 是否引入成熟框架（决策）

**主流栈（2025–2026 共识）**：版面感知解析 → 递归/结构感知切块（~256–512 token + 重叠）→ 嵌入 → 向量库 → **混合（dense+BM25）+ RRF** → cross-encoder reranker → 查询改写（rewrite/HyDE）→（agentic 迭代）→ 评测（RAGAS）。
**现状对照**：本系统已踩 ~80%（混合+RRF+reranker+token 预算路由+agentic harness+逐条 provenance）。差的主要是**切块质量、查询改写、评测闭环**。

**成熟框架**：通用=LlamaIndex / LangChain / Haystack；离线可自托管 RAG 系统=RAGFlow / Onyx(原 Danswer，带 RBAC，最像情报检索系统) / txtai / AnythingLLM；复杂中文/扫描件解析=MinerU / Docling；图谱式=GraphRAG / LightRAG。

**决策：不套重框架。** 理由：
1. **与本架构打架**：通用框架默认有向量 DB、云模型，且无本系统的**零外发审计 + 哈希链 provenance + 密级访问控制**；塞进来等于重写其检索层。
2. **套壳风险**：按老师评分（自研、非套壳、要赢别人 skill），"用了 RAGFlow"是减分；"手搓检索 + 逐条 provenance + 量化 benchmark"才是加分。差异化恰是**情报域的可审计可溯源**。
3. **缺的是点状升级，不是换地基** → 借鉴具体技术（切块 / Contextual Retrieval / 查询改写 / 评测 / GraphRAG 用于垂直 skill）。

---

## D5 — OCR 内容要不要"喂 LLM 整理"（决策，涉及溯源红线）

**问题**：OCR 文本乱（断行/乱序/页眉页脚），要不要用 LLM 整理得更规整？

**决策：可以用 LLM，但绝不让 LLM 改写后的文本成为"被引用的原文"。**

**理由（守红线）**：系统根基是 `content_hash = sha256(chunk.text)` + 引用指向**逐字源片段** + 复核员比对原件。一旦 LLM 整理：
1. 被引用的"事实"可能是 LLM 脑补 → 情报场景致命；
2. LLM 纠错会编造/漏字/错并；**气隙本地模型更弱**，风险更高；
3. `resolveValidCitations` 校验 + 人工比对原件会**当场穿帮**（chunk 与扫描图不一致）；
4. 慢、吃算力（OCR 本就 ~2min/几页，每页再加一遍 LLM）。

**安全替代（推荐顺序）**：
1. **bbox 几何重排**（确定性、零幻觉、可审计）：用 PaddleOCR 已返回的行 `box` 恢复阅读顺序 + 按行距聚段 → 见 D8。
2. **Contextual Retrieval**：LLM 只产"检索用上下文"，chunk 可引用文本仍 verbatim → 见 D10。
3. **双存**：LLM 整理版仅作"阅读视图"（标注「LLM 整理·非原文」），检索/引用仍锚 raw OCR。

**根因其实在 OCR 质量**：烂到没法用应换更强版面感知 OCR（MinerU）或提 DPI，而非让 LLM 猜。

---

## D6 — 锁定本轮范围与关键取舍（经 AskUserQuestion 与用户确认）

**范围（5 步，顺序固定）**：① 切块重构（前置）→ ② bbox 几何重排 → ③ 评测/benchmark 闭环 → ④ Contextual Retrieval → ⑤ 查询改写。

**用户拍板的取舍**：
- **评测/benchmark 闭环纳入**：先建「问句→应命中 chunk」标注集 → 测基线 → 每步出 delta（这串起来=报告里最有说服力的对比图；也正是老师要的）。
- **查询改写纳入**（rewrite/HyDE）。
- **Contextual Retrieval 生成方式 = 逐块 LLM（最高质量）**：Anthropic 原版（每块带全文问 LLM 要一句上下文）。接受成本（270 块=270 次本地 LLM 调用，气隙无缓存会慢）→ 落地时设 opt-in / 限并发。

**不可商量的不变量（CR 红线）**：
- `chunk.text` 仍 **verbatim / hashed / cited**（不动）；
- `chunk.context`（LLM 生成）**不入 hash、不被引用**；
- 索引文本 = `context + "\n\n" + text`，**只喂 embedding 和 BM25**；引用永远解析回 `chunk.text`。

每步带验收标准（见各 D 节"验证"）。

---

## D7 — 步骤 1：切块重构（size-target 打包）✅ 完成

**实现**（`packages/server/src/materials/material-service.ts`）：新增 `paragraphSpans` + `packChunkSpans`，取代"只拆不并"的 `splitLong`：
- 按空行切出段落跨度（保留原文偏移）；
- **贪心合并**连续短段到 ~`CHUNK_TARGET_CHARS=600`；**单段超 `MAX_CHUNK_CHARS=1200` 才硬切**；
- 返回原文偏移 `{start,end,paraIndex}`，`text.slice(start,end)` 即 verbatim chunk（合并块含段间空行、仍是子串）。
- `chunkText`（文本路径）与 `chunkDocPages`（PDF/OCR 页路径）**共用**该打包器。

**守住的不变量（引用接地红线）**：`slice(char_start,char_end) === chunk.text`、`content_hash = sha256(chunk.text)` 均不变。

**验证**：
- `npm run check` 绿 **554/2**（改了 7 个写死旧块数的测试 + elements 预算测试，改成断言新合并行为，并用长段输入保留"多块"覆盖：char 偏移 / 向量对齐 / byId 多覆盖 / 预算截材）。
- 真链路：3.4KB、**75 个短块**的 markdown → 旧 ~75 块、**新 3 块**，每块字符数 `[600, 582, 222]`。换算 **7.1KB/53 块 → ~12 块**（每块完整语义单元）。

**注意（存量）**：`reindex` 只**重嵌**不**重切**；旧文档要用上新切法需**重新汇入**。

**默认参数（可调）**：`CHUNK_TARGET_CHARS=600`、`MAX_CHUNK_CHARS=1200`（按 CJK 密度取值，约 ~一个语义段；后续可随评测调）。

---

## D8 — 步骤 2：bbox 几何重排（OCR）✅ 完成（A4）

**目标**：扫描件 OCR 不再"每页一块"（D3 病灶）；用 PaddleOCR 已返回的行坐标恢复阅读顺序 + 段落结构，喂给新切块打包器；并为 OCR 块带 bbox 供高亮（落地 deferred 的"扫描件 bbox 行级高亮"）。

**入口**：`material-service.ts` `processDocAtIngest` 的 OCR 兜底分支——现为
`ocrPages.push({ page, text: r.lines.map((line) => line.text).join("\n") })`（单 `\n` 拼接=无空行=塌成一段）。
`PaddleOcrAdapter.ocr(image)` 返回 `OcrResult{ lines:[{text, bbox:[x,y,w,h] 归一化}] }`（见 `model/paddle-ocr.ts` `mapPaddleResponse`）。

**实现计划（v1，可冷启动）**：
1. 新 helper `linesToParagraphs(lines)`：① 按 `y`(上)、`x`(左) 排序=阅读顺序；② 按**行间垂直间距**聚段（gap > ~1.5× 行高中位数 → 段落分隔）；③ 输出文本用 `\n\n` 分隔段落 → 交给 `packChunkSpans` 正常按 ~600 字打包（OCR 路径与文本路径自动一致）。
2. 先拿下"阅读顺序 + 段落结构"（切块直接受益）；**bbox 落到 chunk** 作为 D8 子步：让 `chunkDocPages` 知道每个 chunk 的字符区间对应哪些行 → 取并集 bbox 写 `locator.bbox`（`ChunkLocator.bbox` schema 已支持）。
3. 多列版面（分栏）v1 先不处理（y-sort 单列优先），留 TODO。

**验收**：扫描件每页**多块且尺寸一致**、阅读顺序正确、（子步）chunk 带 `locator.bbox`；`slice===text` / `content_hash` 不变；`npm run check` 绿。

**落地（A4）**：`linesToParagraphs(lines)`（按 y→x 排、行高中位数×1.5 聚段、段内 `\n`/段间 `\n\n`）替换单 `\n` 拼接；`locateOcrLineSpans` 在**归一化后**页文本上 indexOf-from-cursor 定位每行（规避 normalize 偏移漂移），`chunkDocPages` 对每块字符区间求重叠行 bbox 并集写 `locator.bbox`。双评审：独立 Codex 提 ① 多列阅读顺序（按计划 v1 单列、留 TODO，**不修**）② 0 行高把阈值压成 0（已修：仅取正行高求中位 + `medianHeight>0` 守卫）。单测 hand-compute 并集 bbox + `slice===text`/`hash` 不变 + 每页多块。

## D9 — 步骤 3：评测 / benchmark 闭环 ✅ 完成（A1）

**目标**：可复现的检索质量基准，给后续每个技术出 before/after 数字（老师 benchmark 评分点）。

**实现**：独立 `npm run eval`（不进 `npm run check`，因需联网+确定性）。语料 `packages/server/eval/corpus/`：DeepSeek 合成 45 篇虚构情报素材（逐篇纯文本生成，**可续跑**：盘上已有的复用，规避长中文套 JSON 截断 + 后台进程被 SIGTERM 中断丢进度）→ 确定性 `chunkText` 切 227 块 → 逐块"答案只能由本块支撑"的中文 query（措辞与原文不同，并发池生成）100 条，gold=`stem#idx`（切块器确定 → 可复现）。runner 复用产品 `retrieveHybrid`/`rerankTopK`（同代码路径），真 SiliconFlow embed(Qwen3-Embedding-8B,4096)/rerank(Qwen3-Reranker-8B)。指标 `metrics.ts` 纯函数 Recall@5/@10、MRR@10、nDCG@10（确定性单测进 `check`）。

**双评审修**：① gen-corpus 单调用 30 篇→截断（改分批/逐篇）；② gold label 与重建 chunk_id 漂移防护（硬校验）；③ `ndcgAtK` 遇重复 id 可 >1（与 recall 一致去重）；④ 问题数不足显式告警。

**基线（227 块 / 100 query）**：hybrid R@5=0.92 R@10=0.95 MRR@10=0.833 nDCG@10=0.862；rerank R@5=0.95 MRR@10=0.915 nDCG@10=0.924。→ **未触天花板**（首版 30 文档/42 块时 R@5=R@10=1.0 无区分度，已弃），rerank 明显抬升 MRR/nDCG。

## D10 — 步骤 4：Contextual Retrieval（逐块 LLM）✅ 完成（A2）

**实现**：`Chunk.context?`（LLM 生成的情境句）；纯函数 `indexText(c)=context?`ctx\n\ntext`:text` **只**喂 embedding + BM25(`retrieve`) + rerank；`chunk.text`/`content_hash`/Citation/答案上下文一律仍用 verbatim text（引用接地红线不破）。摄入时逐块经 OfflineGuard 生成 context（best-effort，失败留空+审计+不阻断），`MINI_AGENT_CONTEXTUAL_RETRIEVAL` opt-in；reindex 回填。双评审修：逐块授权（每次真实 generate 一条 egress）、reindex 仅在 `.vec` 重建成功后才落 context 进 `.chunks.jsonl`（jsonl⇔vec 一致）、chunk-context 经 PromptStore 解析（admin 可编辑生效）。

**eval（`--variant=cr`）**：hybrid R@10=0.95(持平) MRR@10 0.833→0.809、nDCG 0.862→0.843（略降）；**rerank MRR@10 0.915→0.923、nDCG 0.924→0.930（略升）**。

## D11 — 步骤 5：查询改写（rewrite + HyDE）✅ 完成（A3）

**实现**：检索前改写 query（仅影响检索，原始 question 仍持久化 + 喂答案模型——grep 验证 `retrievalQ` 不入持久化/答案/引用）。可复用纯函数 `rewriteForRetrieval(deps,user,query,mode,prompt)`，`MINI_AGENT_QUERY_REWRITE=rewrite|hyde` 开关（默认 off=零行为变化），best-effort 回退+审计。`askSingle` 接入；eval runner 复用同函数。

**eval**：`--variant=qrewrite` hybrid MRR@10 0.833→0.786、nDCG→0.822（降）；`--variant=hyde` MRR→0.720、rerank 崩到 0.737（明显降）。0/100 改写失败回退。

## Phase A 小结 — benchmark 横向结论（诚实记录；D12+ 留给分析层 skill）

| variant | hybrid MRR@10 | hybrid nDCG@10 | rerank MRR@10 | rerank nDCG@10 |
|---|---|---|---|---|
| baseline | 0.833 | 0.862 | 0.915 | 0.924 |
| cr | 0.809 | 0.843 | **0.923** | **0.930** |
| qrewrite | 0.786 | 0.822 | 0.885 | 0.896 |
| hyde | 0.720 | 0.768 | 0.737 | 0.782 |

**读数**：在本合成基准上，**强 hybrid+rerank 基线已近饱和**（R@10=0.95），通用 RAG 增强**总体不增益**：CR 仅在重排阶段微增（对齐 Anthropic「context 利于精排」）、对一阶段混合略有稀释；query rewrite / HyDE 对"本就贴合 gold 块"的清洁合成 query 过度扩展/假设 → 反降（HyDE 尤甚，气隙弱 LLM 易生发散假设答案）。**这是真实负结果**：这些技术的价值在脏/欠定/大歧义语料，而非"每块自造 query"基准。**工程决策**：三者均实现且 opt-in 默认关，留给真实困难查询；不强行开启以免回退当前基线。创新拿分点上移到原创 skill（矛盾检测，C1：对比 LLM 直出）。**可选**：若要让 RAG 增强显出价值，需另造"更难 query 集"（欠定/多跳/跨块）——属可选实验，非本轮必需。

## Phase B — 多模态摄入做实（消除"上传音视频→暂不可用"）

**B1 音频/图像摄入即加工**：`ingestOne` 媒体分支原无条件 `pending`+降级提示；改为已配置对应槽（音频→asr、图像→vlm|ocr）时**摄入即复用既有 `process()` 路径**（同 authorize/管线/切块/索引/状态机/审计，零管线重复）→ done+timecode/bbox chunk；未配/失败/视频→回落 pending+note。双评审修：① 降级 failed→pending 须**落审计**（不可静默改状态，审计红线）② 并发 409 不可把 processing 覆盖回 pending（原样抛）。视频不动（属 B2）。

**B2 视频真帧/分镜（ffmpeg 8.1.2 本机已装）**：新 `ffmpeg.ts`（本地子进程，同 lit 信任类、不经 OfflineGuard）——`ffmpegAvailable`/`probeDuration`/`parseSceneTimestamps`(纯)/`buildShotRanges`(纯)/`detectShots`(scene 滤镜+showinfo)/`extractFrame`/`extractAudioWav`；`processVideo` 真路径（临时文件→探时长→分镜→逐镜头抽真帧→抽 WAV 喂 ASR，finally 清临时目录）替换 mock，ffmpeg 缺失/任一步失败→回落 mock+诚实 note。`// TODO TransNetV2`。独立评审挑出**BLOCKING 气隙红线洞**：ffmpeg 解析恶意容器可经 concat:/playlist 触发**网络外连**——已修（全 ffmpeg/ffprobe 调用加 `-nostdin -protocol_whitelist file,pipe`，`assertLocalFile` 拒 `scheme://`/前导 `-`）；**MAJOR** 真帧 key 取小数(t1)+端点只认数字 key/恒发 svg MIME→真 PNG 不可服务——已修（frame key 取镜头整数序号、`MediaFrame.format` svg|png 贯通存储与端点 MIME）。本机真 ffmpeg 四命令（含白名单旗标）亲验可跑（probe/detect/PNG 15KB/WAV 64KB）。

每特性 Codex 实现 + Codex/Opus 双评审 + 本地 `npm run check` 闸（**591/2 绿**）。三红线守住（媒体模型调用仍经 authorizeMedia；ffmpeg 锁本地协议；content_hash 不变；降级落审计）。提交 = Phase B 检查点（未 push）。
