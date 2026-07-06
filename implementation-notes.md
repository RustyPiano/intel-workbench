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
