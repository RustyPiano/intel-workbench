# 架构、权限与评测速览

## 一条业务链

```mermaid
flowchart LR
  A["多源素材"] --> B["加工为可定位 Chunk"]
  B --> C["要素与矛盾候选"]
  B --> D["Agent 取证与引用台账"]
  C --> E["人工复核"]
  D --> E
  E --> F["已核准 Finding"]
  F --> G["报告起草"]
  G --> H["提交与核准"]
  H --> I["导出"]
  A -.-> J["哈希链审计"]
  C -.-> J
  D -.-> J
  E -.-> J
  H -.-> J
```

## 三层架构

```mermaid
flowchart TB
  WEB["packages/web\nReact 工作台"] --> API["packages/server\n业务规则、权限、证据、报告、审计"]
  API --> CORE["packages/core\nAgent loop、tools、skills、session、run trace"]
  API --> DATA["cases/<id>/...\n扁平文件 + 原子写 + 串行队列"]
  API --> GUARD["OfflineGuard\n白名单授权与审计"]
  GUARD --> MODELS["本地/内网模型\n开发期可用云端替身"]
```

## 权限矩阵

| 操作 | operator | security | admin |
| --- | ---: | ---: | ---: |
| 查看不高于自身密级的专题 | 是 | 是 | 是 |
| 上传和加工授权专题素材 | 是 | 是 | 是 |
| 发起问答、要素、矛盾分析 | 是 | 是 | 是 |
| 创建/提交 Finding 和报告 | 按专题写权限 | 是 | 是 |
| 核准 Finding 和报告 | 否 | 是 | 是 |
| 查看全局审计 | 否 | 是 | 是 |
| 用户管理 | 否 | 否 | 是 |

角色和密级是两条独立约束：角色决定“能做什么”，密级决定“能看什么”。按钮隐藏只是体验层，服务端仍执行最终校验。

## 当前可复现数字

| 项目 | 结果 | 解释 |
| --- | ---: | --- |
| 自动化回归 | 927 passed / 3 skipped | 3 个跳过均需显式外部模型条件 |
| 测试文件 | 106 passed / 1 skipped | 2026-07-10 `pnpm check` |
| 构建 | 3/3 packages | core/server/web 均通过 |
| 问答错误率 | 30% → 0% | 固定 10 题；目标失败类被消除，仍有两题超时 |
| 检索 R@10 | 0.95 | 清洁合成语料，不能外推真实分布 |
| 历史矛盾 F1 | 0.957 | 2026-07-07 旧算法标注集；新策略待复测 |
| 真实 E2E | 8/8 素材、11 chunks | 103 接地命题，报告 revision 2 导出 |

## 评测口径

- 单元/集成测试验证契约和失败路径，不等同于模型质量。
- Benchmark 必须给出语料、金标、指标和运行日期。
- 真实 E2E 验证链路完整性，不用单个专题的输出数量代替 Precision/Recall/F1。
- 阴性结果必须保留：RAG 增强在清洁语料无净增益；NLI 开思考曾降低召回；简报结构化输出仍可能失败。
