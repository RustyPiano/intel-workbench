# P0+P1+P2 改造计划（应对外部评审）

> 创建 2026-06-22。源于一份基于 GitHub `origin/main` 的外部评审。
> **当前 `main` 领先 `origin/main` 4 个提交**（M1–M5 + 三处 Codex 修复 + D25 日志未 push），
> 评审读到的是旧快照——其两处最重指控（矛盾检测吞错、anchored F1 0.737≪0.957）已在本地修复。
> 本计划只针对「以当前代码库为准」仍然成立的问题。

## 0. 执行协议（每个 Batch 都走这套闭环）

1. **实现**：Codex（xhigh 推理）按本文件对应 Batch 的规格实现，产出 diff + 自述（改了什么/为什么/未覆盖项）。
2. **独立双审**（并行、各自独立上下文）：
   - Opus（xhigh）评审：对照本规格 + `CLAUDE.md` 行为准则 + 三红线，找正确性 bug 与过度设计。
   - Codex（xhigh）评审：同上，独立第二意见。
3. **三审分流**：Claude（编排者）汇总两份评审，去重、判真伪，决定哪些必须修。
4. **修复**：Codex 修（小问题 Claude 可直接修）→ 回到第 2 步，直到两审无「必须修」项。
5. **本地闸**：Claude 在本机跑 `npm run check`，必须绿（见 §0.2）。
6. 进入下一个 Batch。
7. **全部 Batch 完成后**：Claude 做**终审**（全量 diff 通读 + `npm run check` + 三红线 + 计划符合度），再询问是否 push。

### 0.1 三红线（全程不可破）
- **零伪造引用**：任何 citation 必须可由检索集合解析 + 内容哈希校验通过；新增 span 级引用同理（quote 必须是 chunk 原文逐字子串）。
- **审计完整性**：哈希链可校验；任何写操作经 AuditService 落账；失败必须落账且显式抛出，不得「done+空」。
- **离线红线**：出站统一过 OfflineGuard（应用层）；不新增任何云依赖到主路径。

### 0.2 本地验证闸
- 命令：`npm run check`（lint + typecheck + 全部测试）。基线约 620 绿 / 2 已知。
- ⚠️ Codex 沙箱屏蔽 TCP，`packages/server/tests/api.test.ts` 在 Codex 内必然假阴性（null port/EPERM），`bash.test.ts` 偶发。**判定一律以 Claude 本机 `npm run check` 为准**，不采信 Codex 沙箱内的测试红。
- 每个 Batch 新增的功能都要带测试（见各 Batch 验收）。

### 0.3 执行顺序与依赖
A(P0) → B(P1.1 多模态) → C(P1.2 span 引用，**P2.2 的前置**) → D(P2.1 任务编排) → E(P2.2 Finding 报告) → F(基准/文档) → G(P2.3 部署) → 终审。
A/B 相互独立可先行；C 必须在 E 之前；F 依赖 B/C/E 的产物数据；G 最后整合。

---

## Batch A — P0：去套壳感 + 纠正错误产品语义

低成本、低风险、可独立验收。四个子项互不依赖。

### A1. README / 产品叙事改版
**问题**（现状已核）：根 `README.md` H1 仍是 `mini-agent`，首屏讲通用 runtime/CLI/bash/read-write-edit，Quick-start 用 `gpt-4.1`，音视频示例以 DashScope/豆包/火山 TOS 为主。
**做**：
- 根 `README.md` 改为**产品 README**：H1 = Intel Workbench（离线多模态情报证据分析工作台）；首屏列核心能力（多模态素材加工 / 证据级溯源 / 矛盾与交叉验证 / 任务化研判 / 报告复核与审计）。
- 通用 runtime 文档下沉到 `packages/core/README.md`（新建或补全）；根 README 用一句话点明「底层自研 Agent Runtime 作为基础设施」并链过去。
- 首屏 Quick-start 改为产品启动路径（本地模型 + DeepSeek/本地服务的开发替身说明），不把 `gpt-4.1`/DashScope/豆包/TOS 放首屏；这些降为「可选云替身（开发期）」小节，并明确与离线定位的关系。
- 对外叙事统一为「Intel Workbench 使用自研 Agent Runtime」，不是「mini-agent 上做了个工作台」。
**不做**：不改 runtime 代码；不删 core 的能力。
**验收**：根 README 首屏无 `mini-agent` H1、无 `gpt-4.1` 作为默认主路径；`packages/core/README.md` 存在并覆盖 runtime；链接可达。

### A2. 默认口令 / 首启安全
**问题**（已核）：`packages/server/src/auth/user-store.ts:52-56` 首启硬编码 `admin/admin123`、`operator/operator123`、`security/security123`，无强制改密。
**做**：
- 首启不再写死弱口令。生成**一次性随机管理员口令**（写入受限文件 + 启动日志/stdout 一次性显示），首次登录**强制改密**。
- 加最小弱口令校验（长度/非默认）。
- 演示账号仅在显式 `MINI_AGENT_DEMO=1`（或等价开关）下创建，并在 README/部署文档标注。
**验收**：新增测试——无 demo 开关时不存在 `admin123` 等；首启生成随机口令；强制改密标志生效。

### A3. 措辞纠偏（tamper-evident / OfflineGuard / 越界声明）
**问题**（已核）：
- 哈希链是普通 SHA256（`audit-service.ts:89-91`，无 HMAC/签名/WORM），属 **tamper-evident**；但 UI `CaseWorkbench.tsx:2104` 写「任何篡改都会令链校验失败」，越界。
- OfflineGuard 是应用层 allowlist（`offline-guard.ts`），不是气隙；ffmpeg 有意不经 guard。
- 顺带核：clearance 实为 4 级（internal/secret/confidential/topsecret），任何「3 级」表述需对齐。
**做**：
- UI/文档将哈希链表述改为「审计链完整性校验（tamper-evident）：局部修改/删除/插入会被 verify 检出」，并注明非密码学防篡改（无外部锚定/签名）。
- OfflineGuard 表述改为「应用层默认拒绝外发 + 支持部署于真正离线环境」，不把应用内 allowlist 称作绝对零外发。
- 校准 README/spec 中关于角色（operator/admin/security）与密级（4 级）的任何不一致表述。
**不做**：不改哈希链/guard 的实现（属 P2/未来项），仅纠正声明。
**验收**：grep 不再出现「绝对/任何篡改都…失败」「绝对零外发」类越界措辞；密级表述统一为 4 级。

### A4. 矛盾检测 API：status + coverage 字段
**问题**（已核）：后端 `detect()` 已修为出错抛出（✅），但**返回结构仍只有 contradictions 数组**——前端无法区分「成功但 0 矛盾」「部分覆盖（截断）」「降级」。
**做**：
- 矛盾检测的 **API 响应 / 任务结果**补结构：`{ status: "succeeded"|"degraded"|"failed", contradictions, processedChunks, totalChunks, truncated, warnings, error }`（service 已有 `chunksCovered/chunksTotal`，向上贯通到 endpoint + JobRegistry 结果）。
- 前端矛盾页据此显示「已覆盖 X/Y 块、是否截断、是否降级」，并把 failed 与「0 矛盾」明确区分。
**验收**：新增测试覆盖三态；前端在截断/失败时有可见提示（非静默）。

---

## Batch B — P1.1：多模态证据完整性（caption_frame / ocr_region）

**这是评审最被低估、却直击核心卖点的一项**：现状 `caption_frame` 把**整段素材字节**丢给 VLM、`t` 只写进 locator（`intel-harness.ts:207-220`）；`ocr_region` 把**整图**丢给 OCR、bbox 只作锚点（`intel-harness.ts:233-249`，代码注释自承 mock）。对一个主打「逐字溯源/证据级定位」的系统，这是 provenance 完整性缺口。

**做**：
- `caption_frame(material_id, t)`：用 ffmpeg `-ss t` 抽**该时刻单帧**（复用 `materials/ffmpeg.ts` 既有封装）→ 只把抽出的帧送 VLM；保存抽帧产物哈希 + locator.timecode；抽帧失败显式报错（落账、不静默）。
- `ocr_region(material_id, bbox)`：先按 bbox 裁剪原图（裁剪实现，复用现有图像处理或新增最小裁剪）→ 只对裁剪结果 OCR；保存裁剪产物哈希 + locator.region。
- 两工具产出的 citation 带上「抽帧/裁剪产物哈希」，纳入零伪造红线。
**验收**（评审建议的五一致测试）：固定一张图 + 一段短视频的 fixture，断言
1) 抽帧结果哈希稳定、2) 实际送入模型的图就是抽出的帧/裁剪图、3) bbox 裁剪图正确、4) 输出 locator 与请求一致、5)（可在 web 层补）点击证据显示的画面与之一致。
前四项以单测覆盖；视频/图 fixture 放 `fixtures/`。

---

## Batch C — P1.2：span 级引用 + 支持性校验（最高杠杆的创新点）

现状：citation 只有 `snippet = chunk.text.slice(0,200)`（`citation.ts`），无 quote/offset/quote_hash；claim 状态是 hash 决定的二元 verified/unverified，无「引用是否支持结论」的语义校验。把「块级可溯源」升级为「**span 级 grounded**」——这是直出大模型**provably 给不出**的属性，是可演示、可量化的原创点。

**做**（先覆盖 inquiry 最终答案路径；contradiction 复用为 stretch）：
- 扩展 Citation 模型（`domain/types.ts`）：新增 `quote: string`、`quote_char_start: number`、`quote_char_end: number`、`quote_hash: string`（sha256(quote)）。保留 chunk 级 `content_hash`。locator 带页/段/时间码/区域。
- 引用构造（`citation.ts` + harness 的 create_citation/finalize 路径）：模型给出 quote → **校验 quote 是 chunk.text 的逐字子串**（定位 offset）→ 算 quote_hash → 不是子串则拒绝该引用（零伪造红线，与 content_hash 同哲学）。不再默认用开头 200 字截断。
- **支持性校验步**：对 (claim, quote) 跑一次判定，打标 `supports | mentions | contradicts | context-only`（复用矛盾检测的 NLI 基础设施 + thinking 关闭默认，沿用 D24 结论）。只有 `supports` 计入「grounded」。结果落在 claim/citation 上。
- 指标plumbing：为 Batch F 暴露「结论支持率」（最终答案 claim 中 quote 真正 supports 的占比）与「引用定位准确率」（offset/locator 命中支持 span 的占比）所需字段与导出。
**验收**：新增测试——非子串 quote 被拒；offset 正确；support 标签写入；grounded 仅取 supports。inquiry 端到端用例产出带 span 的引用。

---

## Batch D — P2.1：任务编排层（Case 之上，**附加式、不拆现有 tab**）

现状无任何任务编排（无 TaskTemplate/Run/Stage/Checkpoint），工作台是 per-Case 功能 tab。目标：让用户看到「系统带我走完一项研判任务」，而**非重写**底层——以**叠加层**读现有状态计算阶段进度，降低风险。

**做**：
- 领域对象（`domain/types.ts` + 新 `task/` 模块）：
  - `TaskTemplate { id, name, stages: TaskStageDef[] }`；内置模板「多源事件核验」：素材导入→加工质量检查→证据单元→实体归并【人工检查点】→命题抽取→矛盾检测【人工检查点】→研判结论→报告生成→复核导出。
  - `TaskRun { id, caseId, templateId, status, stages: TaskStageState[], createdAt }`；`TaskStageState { key, name, status: pending|active|done|failed|skipped, checkpoint?: boolean }`；`Checkpoint`（需人工确认才放行）；`TaskArtifact`（stage→产物，如某次矛盾 run / 报告）。
- 服务 + 存储：`task-service.ts` + 每 case 的 jsonl 存储；端点：创建 run、推进/标记 stage、确认 checkpoint、查询 run。**阶段状态尽量由现有数据派生**（如已上传素材→导入 done；有矛盾 run→该阶段 done），人工检查点显式确认。所有动作落审计。
- Web：任务中心（列任务/当前阶段/加工状态/待复核项/高风险矛盾数/报告状态）+ 工作台顶部阶段条（X/Y、待办检查点）。现有 tab 作为各阶段的主体内容，不删。
**验收**：能对一个 case 起一个 run、推进阶段、卡在人工检查点直到确认、查询进度；服务层有测试；UI 显示阶段进度。
**风险**：本 Batch + E 是整个计划的大头；保持附加式以便随时可停在「可用的更好系统」。

---

## Batch E — P2.2：Finding 驱动报告 + 导出证据覆盖闸（依赖 C）

现状报告 `DraftInput` 不绑定证据，导出闸只查 `status==="approved"`（`report-service.ts`）。目标：报告由**已审核 Finding** 生成，导出前查证据覆盖。

**做**：
- 领域对象：`EvidenceUnit`、`AtomicClaim`、`Finding { id, caseId, conclusion, supportingCitations[], opposingCitations[], confidence, reviewStatus, openQuestions }`、`ReviewDecision`。
- Finding 存储 + UI：从 claim/citation（含 Batch C 的 span 引用）汇聚成 Finding；人工确认/驳回（ReviewDecision，落审计）。
- 报告结构：段落带 `finding_ids[]` + `citation_ids[]` + `coverage_status`；报告生成 Agent **只读已审核 Finding**，不自由全料撰写。
- 导出闸增强：除 `approved` 外，校验——关键结论引用覆盖率（阈值，如 100%）、引用仍有效（hash/quote 校验）、无被驳回 Finding、无未处理高严重度矛盾、无未引用的模型生成事实；任一不过则拒绝导出并给出具体原因。
**验收**：测试覆盖——覆盖率不足/存在被驳回 Finding/失效引用→导出被拒并报因；正常路径可导出；report 状态机与既有审计不回归。

---

## Batch F — 基准与文档（依赖 B/C/E）

**做**：
- 矛盾检测基准叙事**改为「持平直出 F1（1.0/0.917/0.957=0.957）+ 可溯源/全覆盖/可审计」**，明确**不**宣称精度/F1 优于直出（`docs/report/benchmark-summary.md`、`practice-report.md`、`rag-quality-decision-log.md`）。
- 新增任务级/证据级指标并跑出数：结论支持率、引用定位准确率、报告引用覆盖率、（条件允许）无依据结论率、矛盾召回率、重复运行一致性、失败可见率。小标注数据集大小与「自造合成、可能与切块/Prompt 耦合」的局限。
- 决策日志续写本轮 D26+；HANDOFF 同步。
**验收**：基准文档无「优于直出」措辞；新指标有数有方法说明；日志/HANDOFF 更新。

---

## Batch G — P2.3：一键离线部署包

**做**：新建 `deploy/`：`docker-compose.yml`（node app：server+web）、`docker-compose.gpu.yml`（可选）、`.env.example`、`init.sh`（首启随机管理员、数据目录）、`healthcheck.sh`、`model-profiles/`（本地模型端点模板：FunASR/PaddleOCR/本地 LLM/Embed/Rerank/VLM 的 URL 占位）、`offline-install.md`（无网安装：npm 离线缓存、ffmpeg、本地模型服务为外部依赖的说明）。锁定 Node/Python/FFmpeg/OCR 版本。提供「一条启动 + 一条验证」命令。示例案卷 + 数据目录挂载 + 备份恢复说明。
**说明**：本地 Python 模型服务（FunASR/PaddleOCR 在 `../`）为外部依赖，compose 通过 env 指向，不打进包；offline-install.md 写清。
**验收**：`deploy/` 齐备；compose 能起 app（本机验证）；init 生成随机管理员；healthcheck 通过；文档自洽。

---

## 终审（Claude，最后一步）

- 全量 diff 通读，逐 Batch 对照本计划验收项。
- 本机 `npm run check` 绿（容忍 §0.2 已知项）。
- 三红线复核：零伪造引用（含新 span/抽帧/裁剪产物哈希）、审计完整性（含失败落账抛出）、离线红线（无新增云主路径）。
- 越界措辞复检（tamper-evident / OfflineGuard / 不宣称优于直出）。
- 输出终审报告：完成项、未覆盖/降级项、残留风险、deferred。
- 询问用户是否 `git push origin main`（届时本地领先提交一并推出，公开仓库一步跳到改进后状态）。

## 排期与风险（诚实提示，不改变全量决定）
- P0(A) + P1(B,C) 单独落地即已实质回应评审与评分要点（创新性靠 B/C，规范性靠 A，工作量全程可见）。
- P2(D,E,G) 是工作量大头；按 Batch 设了 check 点，任何时刻可停在一个自洽、更好的系统上。
- 已知 deferred（沿用旧记录，不在本轮）：矛盾召回的嵌入式实体归并、cam++ 多说话人调阈、扫描件 bbox 高亮、per-tool runId。
