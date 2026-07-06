# Implementation Notes — Agent 成功率修复（阶段一）+ 透明化（阶段二）+ 目标驱动工作台（阶段三）

## 阶段三 M5 全链路彩排（2026-07-07，真模型，8 份港口案卷子集）

主线验收通过：新建专题 → 批量上传（8 份全 done）→ 自动流水线零点击推进（要素 → 矛盾 → 自动研判 4/4，取消路径实测有效）→ 简报 5 句带引用概览 → 候选 apply → security 核准 2 条 → 矛盾处置 → 覆盖率 2/5 → 4/5（时间线缺口为子集真实状态）→ 报告 draft→submit→approve→export 出 bulletin.md。演练数据保留在 cases/演练2-夜间转运线索核验，可在界面直接查看。

彩排发现并当场修复（每一条在演示现场都可能爆）：

1. cite 模糊匹配的空白折叠 bug：模型引文跨原文换行处不带空白（"。\n登记"→"。登记"）时无法命中；归一化从"折叠为单空格"改为"整体剔除空白"（intel-harness normalizeForMatch），带回归测试
2. search_materials 把字符串 "null" 当真实素材 ID：按未指定处理（模型常见 quirk），带回归测试
3. 矛盾抽取批次失败原因被吞：ClaimBatchResult 携带 error，warnings 透出原因——正是靠这条当场定位了下一条
4. structured.ts 的 generateJson 默认 maxTokens=1500 硬上限：改为尊重 MINI_AGENT_MAX_OUTPUT_TOKENS（所有直调受益）
5. 模型温度 0 下稳定产出漏逗号 JSON（第 248 行）导致矛盾批次整批失败：parseJsonOutput 增加保守修复回退（补元素间漏逗号 + 平衡前缀截取，tests/structured-parse.test.ts），矛盾检测从 degraded/0 条变为 succeeded/11-11 全覆盖并命中预埋的靠泊时间矛盾（0.75）
6. 简报概览句校验用严格子串导致整段被拒（degraded 且无原因）：复用 cite 的 fuzzyLocate（哈希保证不变），0 句 → 5 句全过；降级原因补齐观测（overview-sentences-rejected / unknown-error 兜底）
7. 概览引用显示素材 ID 而非文件名：generateOverview 接入 manifest 文件名映射

流程注意事项（写给演示脚本）：素材必须**批量**上传（单个流式逐传会在第一份完成时触发自动流水线，后续素材因产物幂等跳过不被分析——M1 已知限制的现场表现）；auto-draft 是"生成建议稿"，落盘需再 POST /report/draft（人先过目再保存，语义如此）。

全量回归：typecheck 全绿，877 测试通过。

## 阶段二：事件协议 v2 + 方向 B 工作台（2026-07-06）

- server：`InquiryStreamEvent` 扩为 11 种事件；新增 `inquiry/stream-summarizers.ts`（13 个工具的本地化标题/参数摘要/结果摘要/detail）；cite/add_claim/submit_finding 触发台账事件；每个 tool_result 后发 budget；done 带 run_id；core 补 `reasoning_delta` 流式透传（generate/stream 一致），agent 路径按"标准关/deep 开"接通 thinking
- web：InquiryPanel 实况区重构为方向 B 双栏（EventFeed/ToolCard/EvidenceLedger/InquiryRunView + runModel 纯函数），历史条目挂会话内"研判过程"回看；新样式全部走 styles.css token，无新增内联样式
- 我方手工接线：/stream 路由与 web 客户端透传 deep；深度模式从"阻塞无反馈"改为与标准模式同一条流式路径（可停止、可看思维链）；删除了因此闲置的 askInquiryDeep 客户端函数
- 端到端实测（demo 服务 + 真模型）：标准问答流出 19 对工具卡 + 5 cite_added + 3 claim_added + done(run_id)，答案命中地磅矛盾；深度模式流出 697 条 thinking。事件样本：scratchpad/e2e-sse.txt、e2e-sse-deep.txt
- 全量验证：typecheck 全绿，842 测试通过
- 遗留到阶段三：过程持久化与历史回放（run_id 已具备）、技能激活事件、研判简报/自动研判/覆盖率仪表



日期：2026-07-06 ｜ 方法：先测量、后修复、再复测。偏离计划的决定记录在「Deviations」。

## 基线（来自生产日志，未清洗）

- 来源：`packages/server/cases/*/inquiries.jsonl`，共 52 条问答记录
- status=error：30 条（58%）；insufficient：1 条
- 错误分类：26 条 `Provider returned invalid tool arguments for finalize_answer`；1 条同类错误于 `cite`；1 条 abort；2 条「未通过引用校验」
- 根因：`packages/core/src/model/openai-compatible.ts:134-152` 对工具参数 JSON.parse 失败直接抛致命错误，模型无自我纠正机会；`finalize_answer` 要求一次性提交全部 claims 的大 JSON，是全系统最脆弱载荷

## 决策记录

- **D1（core）**：工具参数解析失败从"致命"改为"喂回模型"——先保守救援（截取最长平衡前缀等），救不回则以工具错误结果返回给模型，在循环内重试；generate/stream 两路径行为一致；检查 finish_reason=length 与 agent 回合 max_tokens。
- **D2（server）**：新增 `add_claim` 工具逐条提交结论（小载荷），`finalize_answer` 退化为封卷动作（保留可选 claims 参数以向后兼容）；同步更新任务提示词与 repair 提示词。
- **D3（server）**：`cite` 增加服务端模糊定位辅助——引文因空白/标点/引号变体不逐字命中时，归一化匹配后映射回原文逐字片段再登记，哈希保证不变；完全不命中仍拒绝。
- **D4（eval）**：新增 `eval/run-agent-eval.ts`（finalize 率 / fallback 率 / 错误分类），固定 10 题问题集；修复前跑 baseline，修复合入后复测对比。基线跑在主工作区，修复在独立 worktree 中进行，避免测量污染。

## 受控基线（2026-07-06，10 题 × 1 遍，deepseek-v4-flash 真端点）

- finalize 率 **70%**，error 率 **30%**（3/3 全部 `invalid_tool_args:finalize_answer`），fallback 0%，insufficient 1（预期内的无证据题）
- 失败题共同特征：cite 数最多（20/25/29 条）→ finalize 大载荷解析失败，与"大 JSON + 4096 默认 max_tokens"诊断一致
- 结果：`packages/server/eval/results/agent-eval-baseline.json`；沙箱网络首跑作废留档（7/10 terminated 为沙箱切断长连接的环境假象，复测须在沙箱外跑）

## 集成记录

- core 修复已合入主树：7 文件直拷 + agent.ts 三方合并（worktree 基点 dcd96ff 落后主 HEAD 约 20 commit），`pnpm vitest run packages/core` 337 过
- server 移植：worktree 补丁无法机械应用（主树同文件有更新的未提交改动），改为按语义移植到主版本，含主版本特有的 submit_finding/内联提示词的融合

## 修复后复测（2026-07-06，同 10 题、同端点，MINI_AGENT_MAX_OUTPUT_TOKENS=8192，沙箱外）

| 指标 | 基线 | 修复后 |
| --- | ---: | ---: |
| error 率 | 30%（3× invalid_tool_args:finalize_answer） | **0%** |
| answered | 60% | **80%** |
| timeout（评测器 180s 上限） | 0% | 20%（timeline-1、entities-1 两道全案综合题） |
| finalize 率 | 70% | 70% |
| fallback 率 | 0% | 10%（gate-1 未封卷但结构化兜底成功出答） |

- 目标失败类 `invalid_tool_args` 全部消除；基线三个失败题中 berth-1（53s）、transship-1（137s）修复后正常作答
- 代价：增量 add_claim 流程增加工具调用次数，两道广度综合题从"崩溃"变成"超过评测器 180s 上限"（产品路径无此硬上限且有流式反馈，但延迟是真实 UX 问题）
- 结果文件：`packages/server/eval/results/agent-eval-after-fix.json`

## 后续跟进项

1. 评测脚本改进：记录答案文本（当前 JSON 不含，无法离线核对内容质量）；`--timeout` 参数化（广度题需 >180s）
2. 人工抽查：两道"证据不足"设计题现以带引用方式回答（语料确认确无答案，推测是如实报告"登记缺失"等有据事实，需打开产品验证一次）
3. 广度综合题延迟优化（读取批量化 / deep 模式预算策略）
4. `MINI_AGENT_MAX_OUTPUT_TOKENS=8192` 已写入 dev.env.sh；部署文档应同步

## Deviations

- core：未强加 max tokens 硬默认值，走 `MINI_AGENT_MAX_OUTPUT_TOKENS` 配置链（低上限模型硬编码 8192 会直接 400）；server 的 agent 创建处需读该 env 并传入（随 server 移植落地）
- 评测：`insufficient` 计入 finalize 成功（系统如实说"材料不足"是正确行为，不是失败）

### 阶段三 M1（自动流水线，2026-07-07）

- **预跑跨越 checkpoint（最重要，满足 M1 验收"要素与矛盾自动就绪"）**：实际 9 阶段模板里 `entity-merge`（实体归并）checkpoint 排在 `contradiction-detection` 之前。若严格按"逐阶段游标推进、遇 checkpoint 即停"，游标会停在 entity-merge，矛盾检测永不自动跑，与验收"要素与矛盾自动就绪"冲突。**取舍**：AutopilotService 按流水线顺序预跑两个"不需人工输入"的分析执行体（要素抽取 → 矛盾检测），使二者产物在用户不点按钮时就绪；而阶段游标仍由 `TaskService.computeStages` 从落盘产物派生并停在第一个未确认 checkpoint（entity-merge）。即 checkpoint 只闸人工确认，不闸可复核产物的预计算。矛盾检测执行体本身不依赖 entity-merge 确认（仅读 elements 别名表），故预跑安全。
- **新增编排文件而非改 TaskService（对 D2"不新建系统"的界定）**：D2 要求"改造现有 pipeline 而非新建系统"。TaskService 现仅依赖 (paths, audit, cases)，其阶段全部从落盘产物派生。为不把 JobRegistry/Element/Contradiction 依赖塞进 TaskService，新增薄编排层 `task/autopilot-service.ts` 复用既有 TaskService 管线与 JobRegistry。未新建任何 pipeline/阶段系统，TaskService 逻辑除阶段显示名外零改动。
- **审计 actor 双轨（对 D6"actor 标记 system-autopilot / 密级按创建者收敛"的落地）**：现有审计 `append({user})` 只是字符串，但 TaskService.createRun/advanceStage 的 `assertCanMutate` 与 Element/Contradiction 的密级校验、出站授权都硬绑真实 Identity（owner/admin），无法以"system-autopilot"身份通过。**处理**：AutopilotService 自身的决策事件（`autopilot.run.create/advance/fail/stop/skip`）以 `user:"system-autopilot"` 落审计；底层 mutation 与执行体（`task.run.create`、`element.extract`、`contradiction.detect`）仍以触发者（摄入/加工时经 requireWriteAccess 已收敛为 owner/admin）身份执行并记账。二者形成双轨：系统决策链 + 真实操作链，均满足"密级按创建者收敛"。
- **阶段显示名改 `evidence-units`：证据单元 → 要素抽取（偏离 D2 举例的"素材加工"）**：web 的 `taskStageName` = `TASK_STAGE_DISPLAY_NAMES[key] ?? stage.name`，只覆写 4 个 key，其余回退 server `name`。用户可见且属工程词的 server 名只有"证据单元"。D2 举例改为"素材加工"，但会与相邻的"素材导入/加工质量检查"语义打架；且该阶段派生完成即 `elementCount>0`、自动流水线在此跑的正是要素抽取，故改为"要素抽取"更贴事实且与产品"要素"术语一致，并顺接下一阶段"实体归并"。key 与持久化格式不变（computeStages 始终以模板 `def.name` 渲染，旧 run 显示同步更新，不破坏数据）；web 标签文件未改。仅同步更新 task-service.test.ts 一处断言。
- **失败恢复走"新建 run"而非"就地清 failed"**：执行体失败时标记对应阶段 failed（evidence-units 经 advanceStage；contradiction-detection 因被 checkpoint 阻塞不可 advance，其失败由落盘 result.status=failed 派生）。因 computeStages 中 stored `failed` 会覆盖派生，就地重跑不清除失败态。恢复路径沿用既有语义：失败 run 为终态，下次素材状态转换触发时 createRun 新建 run 并从当前产物重新派生（成功重跑后新 run 的阶段派生为 done）；人工重跑 job 亦始终可用。
- **已分析专题增量加素材不自动重分析（M1 已知限制）**：autopilot 以产物存在（elements.json / contradictions.result.json）幂等跳过，避免重复触发重跑、与人工复核抢跑。故向已分析专题新增素材后不会自动重跑分析（需人工重跑 job）。留待后续里程碑按需处理陈旧性。
- **模型未配置降级为"跳过"而非"失败 run"**：启动时文本 LLM 未配置 → autopilot 落 `autopilot.skip(reason:model-unavailable)` 并直接返回（不建 run、不产生每次上传都失败的噪声），人工路径不受影响；运行期 job 失败（网络等）仍标记阶段 failed 并带明确 reason（满足 D6/需求 5 的"明确 reason、不卡死、不抛未捕获异常"）。

### 阶段三 M2（研判简报，2026-07-07）

- **缓存边界：只缓存"派生快照"，实时字段每请求现算叠加（对 D5"brief.json 缓存"的落地界定）**：`cases/<id>/brief.json` 只存进指纹的派生部分（LLM 概览段 + 素材/加工统计 + 时间线 + 关键实体 + 未处置矛盾 + 待核问题 + generatedAt/degraded/fingerprint）。任务阶段条（`tasks.getCurrentRun`）、autopilot 开关（`manifest.autopilot`）、覆盖度占位每次 GET 现算叠加，**不进指纹**。原因：确认检查点/推进阶段只写 `task-runs.json`，若纳入指纹会让这些廉价操作误触发一次 LLM 概览重跑；这些字段本身廉价，现算即可保证实时。
- **指纹用"素材签名 + 产物文件 size:mtime"，含 `contradiction-acks.json`（对 D5"素材/要素/矛盾/结论变更即 stale"的落地）**：指纹 = 素材（id/status/chunk_count/processed_at）+ elements.json / contradictions.result.json / contradiction-acks.json / findings.json 的 `size:mtimeMs`。素材签名含 `processed_at`/`chunk_count` 以捕获"素材数不变但重加工"的内容变更；矛盾处置（ack）单独成文件，纳入指纹以让"未处置矛盾/待核问题"随处置即时刷新。
- **概览防编造：服务端逐句 quote 校验后丢弃不过关句（计划 §4 风险条落地）**：概览经 `generateJson` 产出 `[{text,chunk_id,quote}]`，服务端逐句校验 chunk 命中本次上下文、`sha256(chunk.text)===content_hash`、quote 为原文连续子串（复用 `chunkToCitation`，其内部会再核一次子串），任一不过整句丢弃；每句携带 `citation`（含 quote span 偏移/hash）供前端点回原文。LLM 未配置 / 出站被 OfflineGuard 拒 / 无已加工素材 / 生成或解析失败 → 概览为空 + `degraded:true`，整份简报仍返回统计部分（不抛错、不阻断）。
- **待核问题复用规则版 `suggestQuestions`（不叠加额外 LLM 调用）**：简报"待核问题"取 `SuggestionService.suggestQuestions`（纯规则、不出网），只在重算时计算并进缓存快照，避免轮询时重复触发 `suggestion.questions` 审计与图谱重建；不用 LLM 版以免每次重算多打一次模型。
- **"阶段条并入简报头部"= BriefPanel 复用 TaskOverview 组件（对任务项 7"删除因此闲置代码"的界定）**：TaskOverview 从 CaseWorkbench 外壳移除后改由 BriefPanel 头部渲染（起草/确认检查点/标记阶段等交互整体保留），故该组件仍被引用、无闲置代码需删；VerificationSummary 未在任务范围内，保持在外壳不动。BriefPanel 头部另加 autopilot 开关（PATCH `/cases/:id` 的 autopilot 字段，复用既有通道）与"刷新概览"（`?refresh=1`）。
- **待核问题→问答 Tab 预填走 URL query（最小侵入）**：BriefPanel 点击待核问题 → 深链 `/cases/:id/inquiry?q=<question>`；InquiryPanel 读 `?q=` 填入输入框并聚焦，随即以 `replace` 清掉 query（避免刷新/返回重复预填），不自动发送（保留人工复核/编辑余地）。沿用仓库既有"URL query 深链"惯例（MaterialsPanel 的 `?material/quote/start/end`）。
- **简报读端点不额外审计，重算才记 `brief.generate`（对任务项 5"读类无审计惯例则不加"的落地）**：命中缓存的 GET 不落审计（与 overview/task 读服务一致）；仅重算（含一次 LLM 出站）记一条 `brief.generate`（附 degraded/句数/要素数等），与 element/contradiction/suggestion 的"compute 记账"惯例对齐。密级/存在性校验复用 `cases.get`，不可读专题在入口抛 403/404。

### 阶段三 M3（自动研判批处理，2026-07-07）

- **复用既有构件而非新造产物类型（D3 落地）**：新增 `inquiry/auto-inquiry-service.ts` 编排既有链路——出题走 `SuggestionService.suggestQuestionsWithLLM`（内部即「优先 LLM、未配置回退规则」）→ 过滤 `basic` 类、去重已问过的问题（`inquiries.list` 归一化键）→ 逐题走与手动 `POST /inquiries` 完全相同的 `InquiryService.ask`（agent 路径）→ 产物照常落 `inquiries.jsonl`（含结构化候选），由既有 `suggestFindings` 的「问答候选 → Finding 候选池」机制入池。不新建 Finding 生成器、不新建产物类型。默认上限 8 题、`MINI_AGENT_AUTO_INQUIRY_MAX` 可调、顺序执行。
- **「去重 brief 已列出的相同问题」= 去重已问过的问答（对 D3 措辞的界定）**：按 `inquiries.list` 里已存在的问题（归一化去尾标点）去重，避免重复问答，与既有 `generateFindingSuggestions` 同口径。这也是批处理的题级幂等（重跑不会重问已答题）。
- **AbortSignal 贯通到底层 agent（新增 `ask` 的 signal 选项，最小改面）**：`InquiryService.ask` 的 opts 增加可选 `signal`，透传 `askViaAgent → runAgentInquiry → conversation.send`（与 `askStream` 同一条中止路径）。单发（single）路径为测试遗留、生产不用，未接 signal。批处理即以「同一 `ask` 入口 + signal」取消，评测脚本也走同一 `ask` 入口（满足需求 5「以同一 ask 入口为准」）。
- **进度落盘 `cases/<id>/auto-inquiry.json`，简报现算叠加、不进指纹（对需求 3「批处理进度属每请求现算侧」的落地）**：批处理进度（整体 `status/total/completed/currentIndex` + 逐题 `status(pending/running/candidate/done/failed)/inquiryId/candidateCount/error`）原子写盘；`BriefService` 新增 `autoInquiry` 实时字段每次 GET 现算读该文件叠加，**不进 brief 指纹**（避免批处理写盘误触发一次 LLM 概览重跑）。逐题问答自身仍按指纹（`inquiries.jsonl` 非直接进指纹，但候选/结论变更经 findings/矛盾链反映）自然刷新概览。
- **每题状态 5 态（对需求「待跑/进行中/已产生候选/失败」的诚实超集）**：需求列 4 态，但「跑完但未产候选」（如证据不足题）需如实区分，故加 `done`（已完成、无候选）。「已产生候选」判据贴合 `suggestFindings`：结构化候选须 ≥1 条支持引用 supported，或支持型结论 supported 且 ≥2 条 supported 引用无对立——仅用于徽章，真正证据校验/去重仍在 `suggestFindings` 落地。
- **接入 autopilot 为「矛盾检测之后」的第三执行体（对应「补充核验取证」阶段）**：`AutopilotService.STEPS` 追加 `{ stageKey: "proposition-extraction", kind: "auto-inquiry", artifact: "auto-inquiry.json" }`。虽模板里 `proposition-extraction`（补充核验取证）文本上排在 `contradiction-detection` 之前，但把自动研判排在矛盾检测之后跑，是为让 `suggestQuestions` 能用上已检出的矛盾（矛盾派生问题价值最高）。幂等：`auto-inquiry.json` 已在盘上则跳过（与 M1 elements/contradictions 同规则）；审计双轨沿用 M1——本服务的 `auto-inquiry.*` 与底层 `inquiry.create` 以触发者真实身份记账（操作链），`AutopilotService` 另以 `system-autopilot` 记 `autopilot.advance/fail`（决策链）。
- **不动 TaskService：补充核验取证阶段仍靠人工确认游标推进（延续 M1「checkpoint 只闸人工确认，不闸预计算」）**：`proposition-extraction` 被上游 `entity-merge` checkpoint 阻塞（pending），`computeStages` 不为其加派生完成规则；自动研判只是把候选「预置就绪」，阶段游标待人工确认 entity-merge 后按既有逻辑推进。批处理的进度/失败由 `brief.autoInquiry` + 审计承载，不映射为任务阶段的 done/failed（与 M1 矛盾检测执行体的处理一脉相承）。
- **手动触发复用通用 jobs 路由，不新建路由风格（对需求 2 的落地）**：`auto-inquiry` 作为第三个 `JobKind` 接入 `parseKind` 与 `createJobsRouter` 的 runner 分派，天然获得 `POST /cases/:id/jobs/auto-inquiry/{start,cancel,status}` 与 JobRegistry 的取消能力；`serializeJob` 对 auto-inquiry 也附 `result`（终态进度）便于轮询，但 UI 以 `brief.autoInquiry`（durable，读文件，跨重启可见）为准。
- **web 批处理视图由简报轮询驱动，不再叠第二个 useExtractionJob（单一数据源取舍）**：`BriefPanel` 待核问题板块新增 `AutoInquiryProgressBlock`——整体进度（分段进度条 + `completed/total`）+ 逐题状态徽章；运行中显示「取消」按钮（调通用 `cancelJob(caseId, "auto-inquiry")` 并即时重拉简报，简报 8s 轮询亦兜底刷新）；「已产生候选」的问题渲染为按钮，深链到「结论核验」Tab（候选在那里入池复核）。数据源用简报现算的 `autoInquiry`（durable），比 in-memory 的 `useExtractionJob` 更能跨服务重启存活，故未叠加第二个 job 轮询 hook。新样式全部进 styles.css 复用 token，无内联 style。
- **eval 顺带解决两个遗留项（需求 5）**：`run-agent-eval.ts` 加 `--timeout <秒>`（默认 180，广度题可调大），单题超时上限参数化；结果 JSON 每题新增 `answer`（回答正文）与 `claims`（逐条 `text/status/support_status/citations/materials` 摘要）供离线核对内容质量；顶层加 `timeoutSeconds` 便于复现。`label`/`summary` 结构与既有指标口径不变，全部为「只加不改」的新增字段（保持前后对比兼容）。
- **验证数字（2026-07-07，脚本化模型 / 无真端点）**：新增 `tests/auto-inquiry.test.ts` 7 例（出题→批跑→结构化候选入池的真 agent 集成 / 默认上限 8 / env 调上限 / 去重已问题 / 单题失败不中断 / 取消中止批次且 signal 贯通 / 空题集落盘可查）；扩 `tests/autopilot.test.ts` 至 8 例（三执行体全链路 + 幂等跳过 + 收口触发全链路）。`pnpm vitest run packages/server` 全绿（522 passed / 1 skipped，60 文件）；`pnpm vitest run packages/web` 3 passed；server typecheck（含 eval tsconfig）+ web typecheck 全绿。真端点端到端演练留待 M5 收尾统一跑。

### 阶段三 M3 Deviations

- **自动研判用 deep 模式问答**：批处理 `ask({ deep: true, signal })`，与既有「自动发现候选结论」`generateFindingSuggestions` 一致（更宽检索/读取预算 + 开思考，利于自动研判的彻底性）；代价是单题更慢，但属后台批处理、可取消，可接受。
- **取消中途的当前题**：`ask` 在 abort 时会持久化一条 error 问答记录（与手动流式取消同行为）；批处理据 `ctx.signal.aborted` 把该题还原为 `pending` 并标批次 `cancelled`、停止后续题。该 error 记录是既有 `ask` 的副作用，无害（重跑时按已问题去重跳过）。

### 阶段三 M4（报告覆盖率仪表，2026-07-07）

- **纯只读函数 `report/coverage.ts::computeCoverage(paths, caseId, manifest)`，两处消费同一代码路径（对任务「选侵入更小者」的落地）**：覆盖度属「每请求现算」侧，不写盘、不调 LLM、不记审计。做成独立纯函数直接读专题目录既有产物（elements.json / contradictions.result.json+contradiction-acks.json / findings.json / auto-inquiry.json + manifest.materials），而非塞进 ReportService 或给 BriefService 加构造依赖。`BriefService.getBrief` 在实时字段段（与 task/autoInquiry 并列）调用它点亮 `coverage`；`ReportService.getCoverage` 经 `cases.get` 密级闸门后委派它。两处消费同一实现，杜绝口径漂移。BriefService 会二次读它已加载的 elements/contradictions/findings（几个小 JSON），换取单一实现与「现算独立于快照缓存」的正确性，代价可忽略。
- **五节判定口径（D4 落地，均以现有落盘产物即可判定）**：① 背景与素材概况——`materials` 中 status=done ≥1；② 关键时间线——`buildElementGraph(elements).timeline` 中 `sortKey!==null`（锚定到绝对时间轴）的点 ≥3；③ 矛盾核验——无「confidence≥0.75 且处置状态为 open」的矛盾（阈值取导出闸 `hasHighSeverityContradiction` 既有 0.75 口径，非新阈值）；④ 研判结论——review_status=approved 的 Finding ≥1；⑤ 未决事项——自动研判批次已跑完（status≠running）且每题闭环（candidate/done），pending/running/failed 视为悬空。覆盖度 = 满足节数 / 5；每节返回 `{ key, title, satisfied, detail(人话缺口/满足明细), action(目标 Tab + 动词短语) }`。
- **矛盾「高置信」阈值复用导出闸的 0.75（非任务缺省的 0.7）**：任务允许「若无既有口径用 0.7」，但 report-service 的导出闸 `hasHighSeverityContradiction` 已用 `confidence < 0.75` 判高置信。为让仪表与导出门禁对同一批矛盾口径一致（引导缺口 = 会阻断导出的同一批未处置高置信矛盾），覆盖度沿用 0.75，不引入第二个阈值。
- **「未决事项」口径选自动研判批次（D4 给的两个可选口径中取更可判定者）**：D4 允许「自动研判批次已跑完每题闭环」或「findings 的 open_questions 已列入报告草稿」。选前者——`auto-inquiry.json` 有明确的 `status` 与逐题 `status` 字段，判定确定、且在简报（无报告时）与报告页两处口径一致；后者需报告 spec + finding open_questions 交叉，报告未起草时无从判。**副作用（引导性，符合 D6/M3 叙事）**：批次从未运行（auto-inquiry.json 缺失）→ 该节判为未满足，明细「自动研判尚未运行，待核问题未闭环」，行动深链到补充核验 Tab——即用「跑自动研判以闭合待核问题」的引导，与 M3 自动研判主线一致。
- **暴露通道：brief.coverage 点亮 + 新增只读子路径 `GET /cases/:id/report/coverage`（最小改面，不动导出门禁）**：BriefService 的 `coverage` 字段类型从占位 `null` 改为 `ReportCoverage`（现算，不进指纹，与 M2 缓存边界一致）。报告页另加只读子路径 `GET /report/coverage`（挂 reports 路由，`{ok, coverage}`），不改既有 `GET /report` 契约、不碰 `evaluateExportGate` 任何行为——覆盖率是引导（软），导出门禁是强制（硬），UI 上两回事。ReportPanel 的覆盖度获取失败静默降级（不阻塞报告编辑）。
- **web 复用单一 `CoverageMeter` 组件（简报 + 报告页共用，勿复制粘贴）**：新增 `components/CoverageMeter.tsx`——总览「满足/总数」+ 分节进度条 + 五节清单（满足打勾给明细；缺口给明细 + 深链跳对应 Tab 补证据，复用 `scrollWorkbenchBodyIntoView`）。BriefPanel「报告覆盖度」板块由占位换成该组件；ReportPanel 报告编辑区顶部加同一组件。满足/缺口用现有语义色 token（满足 `--ok/--ok-light`、缺口 `--warn/--warn-light`），克制，全部进 styles.css，无内联 style。旧占位 `.brief-coverage-placeholder`（因换组件而闲置）随本次移除（仅移除自身改动产生的孤儿）。
- **验证数字（2026-07-07，脚本化模型 / 无真端点）**：新增 `tests/report-coverage.test.ts` 8 例（五节结构+行动引导完整 / 无数据不抛错且矛盾节空满足 / 背景 done-total 与空专题文案 / 时间线锚定阈值 / 矛盾未处置阻断+处置后满足+低置信不计 / 结论候选计数 / 未决事项 running·悬空·全闭环三态 / 全满足 satisfiedCount=5 / ReportService.getCoverage 委派+密级闸门）；更新 `brief-service.test.ts` 一处断言（`coverage` 从 `null` 改为断言 `{satisfiedCount:2,totalSections:5}` 与五节满足序列）。`pnpm vitest run packages/server` 全绿（530 passed / 1 skipped，61 文件）；`pnpm vitest run packages/web` 3 passed；server typecheck（含 eval tsconfig）+ web typecheck 全绿。真端点端到端演练留待 M5 收尾统一跑。

### 阶段三 M4 Deviations

- **「未决事项」批次未运行即判未满足**：如上，选可判定的 auto-inquiry 口径带来的后果是——从未跑自动研判的专题该节恒为缺口。这是有意的引导（点缺口 → 去跑自动研判/补充核验），不是硬门禁，不影响导出；与 M3「autopilot 闭合待核问题」叙事一致。若后续希望「无任何待核问题时也算满足」，需引入 suggestion 现算判空（会多打一次规则引擎/图谱），本里程碑不做。
- **无数据专题「矛盾核验」节空满足（非字面「全不满足」）**：任务描述「无数据专题（全不满足）不抛错」。实测无数据时矛盾节因「无高置信未处置矛盾」而空满足（satisfiedCount=1），其余四节缺口。这是语义正确的（该节要求是「无未处置高置信矛盾」，零矛盾即真空满足），测试按实际断言并注明；核心要求「不抛错」满足。
- **cancelled/partial 批次仍算「已跑」**：`auto-inquiry.json` 存在即幂等跳过（含被取消的批次），与 M1 「产物存在即跳过」一致；需重跑走手动 jobs 路由（始终覆盖重跑）。

### 阶段三 M5（收尾：demo 种子适配 + 文档，2026-07-07）

- **时间线锚点补两个既有引用衍生的时间要素，不新增事实**：`report/coverage.ts` 的「关键时间线」节要求 `buildElementGraph` 时间线锚定点 ≥3，seed 原来只有 1 个 `type:"time"` 要素（`el-time-window`，聚合窗口 "2026-07-01 22:30-23:40"）。新增 `el-time-seal-patrol`（"2026-07-02 00:20"，复用既有引用 `cSealPerfect`）与 `el-time-customs`（"2026-07-02 09:30"，复用既有引用 `cCustomsTime`）凑够 3 个锚点，均取材已在 seed 中使用过的引用，不引入新素材事实。
- **矛盾处置台账：6/7 已处置，`ct-unload-status` 故意留空**——选择依据是引用交叉而非直觉：核对 7 条矛盾与 5 条已核准 Finding 的 `supporting_citations`，`ct-unload-status`（卸货活动完成状态：`cDispatchUnload` vs `cFollowupNoUnload`）是唯一一条未被任何已核准 Finding 引用覆盖的矛盾，其余 6 条都能对应到具体 Finding 的处置结论（如 `ct-berth-status`→`f-berth-timeline`），因此可据实标记 `resolved`（`by:"security"`，与既有 `finding.reviewed_by` 一致）。**没有选叙事上更"贴切"的 `ct-seal-status`**（尽管 `m-followup` 的引用 `cFollowupLhGap` 字面写着"未解释 23:18 现场照片与 00:20 封志巡检冲突"）：它的两条冲突引用（`cSealPerfect`/`cPhotoSealMissing`）恰好都被 `f-seal-customs-risk` 引用覆盖，若也标 `resolved` 站得住脚，但把它当"故意留空"就需要额外解释为什么已覆盖的矛盾还不算处置，不如 `ct-unload-status`（零覆盖、零需要辩解）干净。矛盾处置写入同时补齐了 `contradiction.acknowledge` 审计事件（`appendMissingAudit`，字段对齐 `contradiction-service.ts` 真实写法）。
- **auto-inquiry.json 的 candidateCount 复用真实服务同一函数，不手算硬编码**：把 `inquiry/auto-inquiry-service.ts` 内部的 `countCandidates` 改为 `export`，seed 直接调用而非照抄一份计算逻辑或手填数字，避免未来 claims 改动时种子数据与真实口径漂移。四条已种问答记录（`inq-port-key-evidence`/`inq-berth-2230`/`inq-lh7712-risk`/`inq-missing-materials`）代入后 candidateCount 分别为 4/3/3/1，均 >0 → 全部落 `status:"candidate"`；批次整体 `status:"done"`、`total=completed=4`，让简报「待核问题」与报告覆盖率「未决事项」节开箱即显示已闭环的批次，而非空态。同步补 `auto-inquiry.batch`/`auto-inquiry.done` 审计事件。
- **未显式设置 `manifest.autopilot:false`（计划书给的二选一，选"不设"）**：依据 M1 语义——seed 直接写盘、不经素材摄入流程，不会触发 `AutopilotService.onMaterialsSettled`（启动崩溃清扫同样不经此路径）；即便后续人工往该专题追加素材触发它，三个执行体的产物（`elements.json`/`contradictions.result.json`/`auto-inquiry.json`）均已在盘上，会被幂等跳过（不调用模型、不产生失败 run）。两层保护叠加已足够「避免演示时误触发重跑」，无需再加一层配置开关；理由写在 `seed.ts` manifest 构造处的注释里，供后续读者按同一逻辑判断是否要动这个开关。
- **SEED_VERSION 4 → 5**：新增/改动的产物需要让已有本地工作区/CI 缓存的旧 seed 重新执行才能生效；同步更新 `demo-seed.test.ts` 三处硬编码的 `"version": 4` 断言为 `5`。
- **HANDOVER.md 而非 HANDOFF.md 追加交接小节**：两份文档并存，`docs/HANDOFF.md` 最后更新于 2026-06-23，是更早一条技术轨（P3.A–D/Batch F，多模态摄入/矛盾检测 benchmark）的历史交接；`docs/HANDOVER.md` 内部日期 2026-07-03，且自述"本文档用于新对话快速了解项目背景和当前状态"，是持续维护的活文档，故追加到后者。为避免与该文档自身「Phase 1-2」编号（建议/上下文/提示词服务）混淆，新增小节开头注明这里的"阶段一/二/三"沿用 `implementation-notes.md`/`docs/plans/2026-07-06-phase3-guided-autopilot-plan.md` 的编号，是不同批次的工作。
- **新增覆盖率断言进 `demo-seed.test.ts` 既有集成测试**：在既有的"seeds the port verification case..."用例里、矛盾处置台账被测试自身覆盖为「全部 resolved」之前，插入 `computeCoverage` 断言（`satisfiedCount>=4`、矛盾节 `satisfied:false` 且明细 `"1/7 条高置信矛盾未处置"`、其余四节全满足），把「演示专题覆盖率 4/5 且缺口是矛盾节」这条设计意图钉成回归测试，避免未来改 seed 数据时悄悄回退。
- **验证数字（2026-07-07，脚本化模型 / 无真端点）**：`pnpm vitest run packages/server` 全绿（530 passed / 1 skipped，61 文件，含更新后的 `demo-seed.test.ts`）；server typecheck（含 eval tsconfig）全绿。手工用一次性脚本调用 `computeCoverage` 核对种子输出：`satisfiedCount:4/5`，唯一未满足节为「矛盾核验」（明细 `1/7 条高置信矛盾未处置`），其余四节（背景/时间线/结论/未决事项）均满足。

### 阶段三 M5 Deviations

- **未在本次任务中执行计划 §2 M5 验收要求的"一次真模型端到端演练"**：本次委派范围明确为 demo 种子适配 + 文档 + `pnpm vitest run packages/server`/typecheck 回归，未接入真实模型端点跑新建专题→上传→自动跑→简报→报告导出全链路。已在 `docs/HANDOVER.md` 本次新增小节中注明该验收项留待部署前人工执行，不视为静默跳过。
- **不显式设置 `manifest.autopilot:false`（计划任务书给的二选一）**：见上文，判断依据是 M1 幂等跳过语义 + seed 不触发 hook 的双重保护已覆盖"避免演示时误触发重跑"的诉求；如后续产品决定"演示专题一律禁用自动化"作为显式产品策略（而非仅靠现状巧合防护），可再补 `autopilot:false`。
