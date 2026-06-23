# Benchmark 汇总（离线情报工作台）

> 一处汇总两类可复现基准：①检索质量（RAG 四变体）②原创矛盾检测 skill（锚定流水线 vs 大模型直出）。
> 全部用真实云替身模型 + 自造带标注语料跑出，结果落盘于 `packages/server/eval/**/results/`。
> 复现：`source dev.env.sh && npm run eval[ --variant=...]` / `npm run eval:contradiction`。

## 1. 检索质量（RAG）

语料：DeepSeek 合成情报域语料 **45 文档 / 227 切块 / 100 条带标注 query**（每 query 标注其 gold 切块）。检索栈：BM25 ⊕ dense 向量 RRF 混合 + Qwen3-Reranker 重排；embed=Qwen3-Embedding-8B（dim 4096，硅基流动）。

| 变体 | hybrid R@10 | hybrid MRR@10 | hybrid nDCG@10 | rerank MRR@10 | rerank nDCG@10 |
| --- | ---: | ---: | ---: | ---: | ---: |
| **baseline**（混合+重排） | **0.950** | 0.833 | 0.862 | 0.915 | 0.924 |
| cr（Contextual Retrieval） | 0.950 | 0.809 | 0.843 | **0.923** | **0.930** |
| qrewrite（查询改写） | 0.930 | 0.786 | 0.822 | 0.885 | 0.896 |
| hyde（假设答案嵌入） | 0.920 | 0.720 | 0.768 | 0.737 | 0.782 |

**读数（诚实负结果）**：强 hybrid+rerank 基线在该清洁合成基准上已近饱和（R@10=0.95）。通用 RAG 增强**总体不增益**——Contextual Retrieval 仅在重排阶段微增（MRR 0.915→0.923，对齐 Anthropic「上下文利于精排」），对一阶段混合略有稀释；query rewrite / HyDE 在「本就贴合 gold 块」的 query 上过度扩展/发散，反而降分（HyDE 尤甚）。三者均已实现且 **opt-in 默认关**，价值在脏/欠定/大歧义语料而非本基准。**这是真实结论，不是失败**：它界定了技术的适用边界，并把创新拿分点上移到下面的原创分析 skill。

## 2. 原创矛盾检测 skill（锚定流水线 vs 大模型直出；含 NLI 思考分流对照）

语料：自造带标注案卷 **≈30 切块 / 6 虚构文件 / 12 条金标矛盾对**（含跨文件「同事实异说」+ 文件内矛盾 + 干扰项）。指标=矛盾对 Precision/Recall/F1。复现 `source dev.env.sh && npm run eval:contradiction`。

| 方案 | Precision | Recall | F1 | TP | FP | FN |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **anchored（NLI 关思考，默认）** | **1.000** | **0.917** | **0.957** | 11 | **0** | 1 |
| anchored（NLI 开思考） | 1.000 | 0.833 | 0.909 | 10 | 0 | 2 |
| llm-direct（全块丢 LLM 列矛盾） | 1.000 | 0.917 | 0.957 | 11 | 0 | 1 |

**算法**（非「让 LLM 找矛盾」）：①逐块抽原子主张 `{entity,attribute,value,chunk_id}`（LLM，关思考）→ `resolveValidCitations` 丢弃伪造锚点；②**按实体确定性聚类**（非 LLM）；③**仅簇内成对 NLI**（LLM 判 `contradiction|agreement|unrelated`），复杂度 O(Σnᵢ²) 而非 O(N²)；④确定性置信度（关系确定度+是否跨源+数值距离）+ scope（cross/intra-material）。两条矛盾陈述各经 `chunkToCitation` 绑定 content_hash = 逐条 provenance。

**思考分流对照（headline，过程见决策日志 D24）**：我们曾假设「成对 NLI 属难判定 → 开思考求质量」，并据此把判定路由到 thinking-on。实测给出**反例**：NLI **开思考 F1=0.909（recall 0.833）低于关思考 F1=0.957（recall 0.917）**——推理模型「想多了」会把一条真矛盾判成 unrelated。故**按数据把 NLI 路由到关思考**（更快、更省、且召回更高）。「该开思考则开」在此处被 benchmark 明确判为「不开」——这正是老师要的「设计完 benchmark 对比验证」闭环：建机制（thinking on/off 可配，`MINI_AGENT_CONTRADICTION_JUDGE_THINKING`）→ 跑对照 → 让数据定默认。

**关键提升（M1 机制修复，过程见 D20/D21）**：上一版 anchored F1 仅 0.737（recall 0.583）。根因：核心适配器发 `max_completion_tokens`（DeepSeek 静默忽略）令 token 上限失效，且推理模型（deepseek-v4-flash）把预算耗在思维链上 → claim 抽取/判定半截断。M1 改发 `max_tokens` + 思考分流（结构化任务一律关思考）后，anchored **0.737 → 0.957**，**追平 llm-direct**。

**结论 + 价值定位（诚实）**：锚定流水线（关思考）**matches direct-LLM F1 (0.957) while adding zero-fabrication per-claim citations, full-corpus coverage, determinism, and auditability**。也就是说，当前真实结果是 **PARITY（F1 0.957 = 0.957）**，不是精度或 F1 优势；结构化价值在于每条矛盾绑定可校验 provenance / scope、可分批覆盖全语料（M2 分批 + 确定性合并，不随语料增大而单次调用丢上下文）、全程经 OfflineGuard 与哈希链审计。

## 3. 证据级/任务级指标（Batch F）

> 复现（确定性指标）：`npx vitest run packages/server/tests/benchmark-metrics.test.ts`。夹具均为 `docs/report/fixtures/` 下的自造合成小样本；它们用于验证指标定义与管线可跑，不代表真实业务分布，可能与当前切块/Prompt 设计耦合。

| 指标 | 夹具 | 结果 | 方法 |
| --- | ---: | ---: | --- |
| 引用定位准确率 | 6 条 span citation（3 正确 / 2 offset 错 / 1 hash 错） | **3/6 = 0.500** | `chunk.text.slice(start,end) === quote` 且 `sha256(quote) === quote_hash` 才算命中 |
| 报告引用覆盖率 | 5 个 key conclusion slots | **3/5 = 0.600** | 结论槽有 ≥1 条有效 span citation 才算 covered（模拟导出闸） |
| 失败可见率 | 4 个注入失败场景 | **4/4 = 1.000** | tampered chunk hash / failed batch / offline denial / null embedding fallback 均以 failed/degraded 显式暴露 |
| 重复运行一致性 | 1 个确定性聚类输入 | **consistent = true** | 同一输入运行两次，对 canonical JSON 输出做 sha256，hash 相等 |

LLM-dependent 指标已建 harness + 标注夹具（`llm-metrics-fixture.json`，8 条 claim/context/label），但当前不填数字：**pending run (需配置模型端点)**。待接入 NLI judge 后运行 `computeClaimSupportRate`（结论支持率）、`computeUnsupportedClaimRate`（无依据结论率）与 `computeContradictionRecall`（矛盾召回率）；测试中对应用例保持 skip，避免在无模型端点时伪造结果。

## 4. Export Gate Scope Boundary

The export zero-fabrication gate enforces citation backing for all factual content (section body, summary, conclusion, heading text). The report title and header metadata fields (recipient, issuer, date) are editorial/administrative fields that do not require evidence citations — this is an intentional, documented boundary, not a coverage gap.

## 5. 一句话总览

- **检索**：强基线已饱和，通用 RAG 增强在清洁语料不增益（界定适用边界，opt-in 保留）。
- **矛盾检测**：锚定流水线（关思考）F1=0.957 **追平**直出；其价值不是更高 F1，而是 zero-fabrication per-claim citations、full-corpus coverage、determinism、auditability。
- **思考分流**：建了 thinking on/off 机制并 benchmark 验证——NLI 开思考反降召回，故数据驱动路由到关思考（非拍脑袋）；用户可选的「问答深度模式」保留 thinking-on 供开放性追问。
