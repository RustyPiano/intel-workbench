# Implementation Notes — Agent 成功率修复（阶段一）+ 透明化（阶段二）

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
- **cancelled/partial 批次仍算「已跑」**：`auto-inquiry.json` 存在即幂等跳过（含被取消的批次），与 M1 「产物存在即跳过」一致；需重跑走手动 jobs 路由（始终覆盖重跑）。
