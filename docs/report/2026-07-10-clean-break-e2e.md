# 破坏性收敛后真实模型全链路 E2E（批次 F 验证部分）

日期：2026-07-10 · 结果：**全部 21 步 PASS**（总耗时 236.9s）· 基线：`247de2d`（R1/R2/R3a 收敛后）

## 运行方式

```bash
source dev.env.sh
pnpm --filter @intel-workbench/server e2e:real   # 脚本：packages/server/e2e/real-model-e2e.ts
```

- 全程走 HTTP API（`createApp` 起真实 express 服务，随机端口，非直调 service）。
- **临时空数据根**（`mkdtemp`，跑完即删），不碰 `.workbench-data/demo`。
- 真实模型仅文本 LLM（DeepSeek `deepseek-v4-flash`，OpenAI 兼容，host `api.deepseek.com`）；脚本进程内显式清空 Embed/Rerank/OCR/ASR/VLM 槽 → 检索退 BM25，验证对象聚焦在驱动要素/矛盾/研判/问答的文本模型链路。
- `MINI_AGENT_DEMO=1` 仅用于 UserStore 惰性播种演示账号（不触发工作区播种——播种只在 `src/index.ts` 主流程发生）；`MINI_AGENT_AUTO_INQUIRY_MAX` 缺省压到 2 控成本。
- 素材：`demo/port-anomaly-materials.ts` 中 8 份文本（值班简报/AIS/VTS/门岗登记/门岗OCR/地磅/泊位计划/后续简报）。

## 每步结果

| 步骤 | 断言要点 | 结果 | 耗时 |
| --- | --- | --- | --- |
| S1 空数据根启动 | 获数据根 wx+PID 独占锁 + `audit.initialize()` 空链合法 + health `modelConfigured=true` | PASS | 0.0s |
| S2 登录 operator | 200 + token | PASS | 0.1s |
| S3 创建专题（机密） | 201，caseId=`真实模型全链路验证-临时` | PASS | 0.0s |
| S4 批量上传 8 份文本素材 | 201，8/8 status=done | PASS | 0.0s |
| S5 加工完成 | `GET /cases/:id/status` materials ready，processed=8 failed=0 | PASS | 0.0s |
| S6 自动流水线完成 | 轮询 status 至 workflow 三步终态：elements/contradictions/inquiries 均 **succeeded**（真实模型自动研判 2 题） | PASS | 220.3s |
| S7 矛盾检测全量成功 | `result.status=succeeded`（全量覆盖，非 truncated） | PASS | 0.0s |
| S8 登录 security | 200 + token | PASS | 0.0s |
| S9 处置高可信矛盾 | 本次真实模型检出 0 条矛盾 → 无需处置（见「发现」） | PASS | 0.0s |
| S10 真实问答 | 首问（苏E6V03 地磅重量）即得 answered + supported claim（2 claims，含逐字 quote 引用） | PASS | 16.2s |
| S11 Claim 晋升 | `POST /findings {inquiryId, claimId}` → 201 + `promotion.eligible=true` | PASS | 0.0s |
| S12 伪造晋升被拒 | 不存在的 claimId → **404 + `promotion.reason="claim-not-found"`** + 审计 deny | PASS | 0.0s |
| S13 Finding 复核核准 | security → `review_status=approved` | PASS | 0.0s |
| S14 报告草稿 | 201，rendered=true（python3.14 + render_report.py 实测可渲染） | PASS | 0.1s |
| S15 提交 + 核准 | draft → in_review → approved | PASS | 0.0s |
| S16 内容篡改导出 409 | 篡改被引用 chunk 的 text（保留 content_hash）→ 导出 **409**，`result.reasons=["citation:invalid","citation:no-span"]`，审计留 `report.export` deny | PASS | 0.0s |
| S17 恢复重起草 | 还原 chunk 原始字节 → 重起草 revision=2 | PASS | 0.0s |
| S18 提交 | in_review | PASS | 0.0s |
| S19 核准 | approved | PASS | 0.0s |
| S20 导出 | 200，status=exported，产物 185 字节 | PASS | 0.0s |
| S21 审计校验 | `GET /api/audit/verify` → ok=true，count=196（哈希链全量重算通过） | PASS | 0.0s |

## 服务端小修复（本批次）

1. `packages/server/src/finding/finding-service.ts` — 伪造晋升路径（inquiryId/claimId 指向不存在的结论）原实现直接 `throw AppError(404)`，路由只回裸 404、**不带 `promotion.reason`**，与其它三个晋升不合格分支（not-supported / no-valid-citation / already-promoted）的结构化契约不一致。改为与之一致地返回 `{ ok:false, status:404, reason:"claim-not-found" }`（`PromotionReason` 增加该枚举），审计 deny 事件保持不变。S12 实测响应为 `404 + promotion.reason="claim-not-found"`。

## 发现（非缺陷，留档）

- **本次真实模型矛盾检测检出 0 条**（8 份素材含预埋的靠泊时间线/车辆数量/地磅重量冲突）。状态为 succeeded 且全量覆盖，故报告闸不受影响；与 AGENTS.md「下一步候选」中“本轮矛盾策略更保守、需复测召回”的已知事项一致，非本批次回归。
- 导出闸对篡改的反应符合设计：篡改 chunk 文本（hash 不再匹配）即同时触发 `citation:invalid` 与 `citation:no-span` 两个理由，且逐理由落 `report.export.gate` deny 审计。

## 根 package.json 所需接线（由主 Agent 落）

```json
"e2e:real": "pnpm --filter @intel-workbench/server e2e:real"
```

## 验收

- `pnpm check`：**通过**（920 passed / 3 skipped，与基线一致）。
- `pnpm --filter @intel-workbench/server e2e:real`：**ALL_PASS**（21/21，真实 DeepSeek 调用，完整 JSON 摘要见脚本 stdout）。
