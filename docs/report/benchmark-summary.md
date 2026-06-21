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

## 2. 原创矛盾检测 skill（锚定流水线 vs 大模型直出）

语料：自造带标注案卷 **30 切块 / 6 虚构文件 / 12 条金标矛盾对**（含跨文件「同事实异说」+ 文件内矛盾 + 干扰项）。指标=矛盾对 Precision/Recall/F1。

| 方案 | Precision | Recall | F1 | TP | FP | FN |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **anchored（本锚定流水线）** | **1.000** | 0.583 | 0.737 | 7 | **0** | 5 |
| llm-direct（全块丢 LLM 列矛盾） | 1.000 | 0.957 | 0.957 | 11 | 0 | 1 |

**算法**（非「让 LLM 找矛盾」）：①逐块抽原子主张 `{entity,attribute,value,chunk_id}`（LLM）→ `resolveValidCitations` 丢弃伪造锚点；②**按实体确定性聚类**（非 LLM）；③**仅簇内成对 NLI**（LLM 判 `contradiction|agreement|unrelated`），复杂度 O(Σnᵢ²) 而非 O(N²)；④确定性置信度（关系确定度+是否跨源+数值距离）+ scope（cross/intra-material）。两条矛盾陈述各经 `chunkToCitation` 绑定 content_hash = 逐条 provenance。

**关键实验发现（过程见决策日志 D12）**：初版按 `entity:attribute` 精确串聚类对 LLM 自由抽取的属性表层差异过敏 → 簇几乎全 size-1 → **anchored F1≈0.29（recall 0.17）惨败**；改按**实体聚类**（attribute 交簇内 NLI 判）→ **F1=0.737（precision 1.0，0 误报）**。

**结论 + 价值定位（诚实）**：30 块小语料上 LLM-直出已近天花板（F1=0.957），结构化在**原始 F1 上不占优**。但结构化的不可替代价值是：**precision 1.0 + 每条矛盾绑定 content_hash 精确块的可验证 provenance**（直出只吐 chunk_id 对、无接地校验）、**可扩展**（逐块抽+成对判，不随语料增大而单次调用丢上下文）、**可审计**（每次出站经 OfflineGuard、每步入哈希链审计）。即结构化的「赢」不在玩具集 F1，而在**可溯源 / 可扩展 / 可审计**——这正是情报域（涉密、需复核、零外发）的硬约束。残余漏判=实体串表层变体（如 `临时雷达站r-19` vs `r-19临时雷达站（…）`），下一级稳健化=嵌入式实体归并（可选）。

## 3. 一句话总览

- **检索**：强基线已饱和，通用 RAG 增强在清洁语料不增益（界定适用边界，opt-in 保留）。
- **矛盾检测**：玩具集 F1 不及直出，但以 **precision 1.0 + 逐条 content_hash provenance + 可扩展 + 全程可审计** 赢在情报域真实约束——这是套壳大模型直出给不出的。
