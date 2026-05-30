# 大模型编程实践报告：基于 mini-agent 的情报智能应用

> 选题：（1）文本情报整编 + （2）(3) 合并的音视频对话综合分析，共两个可交互智能应用。
> 二者构建于自研本地 Agent runtime `mini-agent` 之上，由自然语言指令驱动完成全流程。

> 说明：本报告为某一时间点的实践记录。其中音视频方法对比所用的 `experiments/` 评测脚手架
> 与经典管线（ffmpeg+Whisper+pyannote）fallback、本地分片合并脚本已在后续清理中移除；当前
> 媒体策略为小文件 Base64 内联、大文件经公网 URL（如火山 TOS）接入。下文对比数据仅作历史参考。

---

## 一、应用背景

### 1.1 功能介绍

| 应用 | 选题 | 功能 | 交互方式 |
| --- | --- | --- | --- |
| **文本情报整编**（intel-bulletin） | （1） | 读取任务文件夹内多份 md/txt/docx/pdf 文档，提炼要点与时间线，整编为符合公文规范的情报报文；支持任务与文件增删改查 | 自然语言：「把 tasks/X 整编成情报报文」 |
| **音视频对话综合分析**（av-dialogue-insight） | （2）+（3） | 对会议/影视/对话音视频做事件检测与时间定位、说话人分析、多模态情感识别、关键触发点解释、多模态总结，产出结构化报告 | 自然语言：「分析这段录像的事件、说话人与情感」 |

两应用均为 **Agent + Skill** 形态：用户下达自然语言指令，Agent 自主规划步骤、
路由调用工具与脚本、处理异常，最终落地报告。

### 1.2 应用场景与价值

- **情报/舆情整编**：把分散的简报、记录、文件快速整编为规范公文，减少人工汇编成本。
- **会议/审讯/谈判分析**：自动定位关键事件时点、刻画说话人、追踪情绪拐点并解释触发原因，
  为复盘与研判提供结构化依据。
- **价值**：以 Agent 自动化替代"人工读取—摘录—排版"与"人工逐帧看录像—记录—标注"的
  重复劳动；本地优先、连接可替换，便于在受控环境中部署。

### 1.3 创新点

1. **不侵入文本核心的多模态接入**：在纯文本 Agent runtime 上，通过"专用工具封装多模态
   模型调用"（见 §3.3）引入音视频理解能力，文本消息/会话/trace 体系零改动。
2. **选题(2)(3)合并为统一 pipeline**：事件定位、说话人、情感、触发点在一条可分片、可降级
   的流程中协同产出。
3. **过程可观测即过程文件**：runtime 自带 run/session/trace，Agent 的规划与工具路由
   轨迹可直接导出为作业要求的"过程文件"。

---

## 二、能力目标达成对照

| 能力目标 | 落地点 |
| --- | --- |
| 1.1 使用 LLM API / 本地模型 | OpenAI 兼容适配器驱动文本 loop；`callOmni` 调用 Qwen3.5-Omni 等多模态模型 |
| 1.2 prompt engineering | `references/analysis-schema.md` 的分目的提示词；公文 `writing-guide.md` |
| 1.3 function calling / tool calling | 工具 zod schema → OpenAI strict JSON Schema（`getToolJsonSchema`）；新增 `probe_media`/`analyze_media` |
| 2.1 业务逻辑拆分 | 摄取/管理/渲染、探测/分析/合并/渲染 分别成脚本与工具 |
| 2.2 封装基础能力为 tool/skill | 两个 Skill + 两个媒体工具 + 多模态 helper |
| 2.3 流程化处理 | SKILL.md 定义确定性工作流，脚本承担确定性计算 |
| 3.1 任务分解（planning） | 由 `probe_media` 时长决定是否分片；多步编排 |
| 3.2 多模态系统 | 视频/音频/图像 content parts；omni 模型 |
| 3.3 tool routing | 按目的路由 `analyze_media` 指令；探测→分析→合并→渲染 |
| 3.4 失败与异常处理 | 重试、分片再切、降级到经典管线、缺流降级 |
| 3.5 完整 pipeline | probe→analyze→merge→render 全链路，附对比实验 |

---

## 三、大模型开发方案

### 3.1 遵循的标准与规范

- **Spec Coding**：先写 spec（`docs/specs/intel-bulletin-spec.md`、
  `docs/specs/av-dialogue-insight-spec.md`）定义接口与验收标准，再实现。沿用 runtime
  既有 spec/plan 文档传统（`docs/mini-agent-runtime-spec.md`、`docs/superpowers/plans/*`）。
- **文档体系**：遵循 Diátaxis（tutorial/how-to/reference/explanation），README 增补多模态
  连接与媒体工具说明。
- **工程规范**：TypeScript strict、zod 入参校验、统一错误码（`RuntimeErrorCode`）、原子写、
  trace 脱敏；新增代码全部配套测试，`npm run check`（typecheck + 183 项测试）全绿。

### 3.2 方案设计与可行性

整体架构（文本核心 + 旁路多模态 + 技能/脚本）：

```
自然语言指令
     │
     ▼
  Agent loop (纯文本)  ──tool calling──►  内置工具: read/write/edit/bash/activate_skill
     │                                    媒体工具: probe_media / analyze_media
     │ activate_skill                              │ callOmni(多模态 content parts)
     ▼                                              ▼
  Skill 工作流 ── bash ──► 捆绑脚本(确定性计算)   多模态模型(Qwen3.5-Omni/Gemini)
  intel-bulletin: ingest / manage_task / render
  av-dialogue-insight: render / merge_chunks / fallback_pipeline
     │
     ▼
  公文报文 / 音视频分析报告  +  run/session/trace 过程文件
```

可行性：媒体接口走 OpenAI 兼容协议，可直接复用现有适配器与连接机制；确定性环节
（解析、合并、渲染、指标）下沉到可离线测试的 Python 脚本；不可控环节（模型调用）
集中在工具内并做异常/降级处理。

### 3.3 实现方式选择（为何是 B 方案：专用工具）

候选：A 脚本旁路、B 专用工具、C runtime 原生多模态。选 **B**：

- 直接命中 1.3/3.3（function calling / tool routing）考点：模型以工具形式调用多模态能力。
- 不动文本核心：`RuntimeMessage.content` 仍为 string，多模态消息封装在 `callOmni` 内
  （`src/model/multimodal.ts`），不触及 session/trace/prompt。
- 选型（2026-05 调研）：**Qwen3.5-Omni**（DashScope，原生全模态、OpenAI 兼容、中文友好、
  音频理解 SOTA）作主力，复用现有 `openai-compatible` 适配器；**Gemini 3.x** 原生视频作
  先进性对比；**经典管线**（Whisper+pyannote）作传统基线。

### 3.4 实现程度

- 两应用均端到端可跑通并有测试覆盖；M0 多模态基础设施 + M1/M2 两个 Skill + M3 对比实验
  harness 全部落地。
- 媒体工具、脚本、技能工作流、fixtures、对比实验报告齐备；`doctor` 可自检多模态连接
  （`[multimodal_path]`）。

---

## 四、应用效果分析

### 4.1 文本情报整编

多源任务（md + txt）经 Agent「建任务→收录→摄取→起草 spec→渲染→登记」整编出确定性
公文，结构含标题/密级/主送/概要/分小节/结论/落款日期，与期望报文逐字一致
（见 `fixtures/intel-bulletin/expected-report.md` 与 readiness 测试）。CRUD 与 DOCX 标准库
摄取均有脚本级测试佐证。

### 4.2 音视频对话分析 — 方法对比实验

数据集 `experiments/dataset/`，方法产出 `experiments/results/`，指标见 `experiments/metrics.py`，
跑批：`python3 experiments/run_experiment.py`。示例片段（meeting-clip，±3s 容差）结果：

| 方法 | 事件F1 | 情感标签准确率 | 效价MAE | 说话人数完全匹配率 | 概要重合F1 | 降级 |
| --- | --- | --- | --- | --- | --- | --- |
| classic-pipeline | 0.222 | 0.000 | — | 1.000 | 0.051 | 是 |
| gemini | 0.750 | 0.667 | 0.100 | 1.000 | 0.147 | 否 |
| **qwen-omni** | **1.000** | **1.000** | **0.067** | **1.000** | **0.854** | 否 |

**结论**：
- 多模态 omni 方法在事件定位、情感识别、总结质量上显著领先；Qwen3.5-Omni 略优于 Gemini。
- 经典管线（ffmpeg+Whisper+pyannote）擅长说话人分离（人数完全匹配），但**结构上缺失**
  多模态情感与触发点（emotion/triggers 为空），印证了 omni 方案对(3)情感分析的价值。
- 该对比同时是失败降级路径：omni 不可用时回退经典管线仍能产出（标注 degraded）。

> 说明：当前为小样本示例与轻量代理指标（概要用字符二元组重合；说话人用人数匹配代理 DER）。
> 扩样本、引入 LLM-judge 与帧级 DER（pyannote `DiarizationErrorRate`）是直接的增强方向。

### 4.3 与相关工作对比（先进性）

- 相比"单一视觉/语音模型 + 人工拼接"，本方案以 Agent 统一编排、自动分片与降级，覆盖
  事件/说话人/情感/触发点四类输出。
- 相比纯云端黑盒工具，本方案本地优先、连接可替换（OpenAI 兼容），过程可观测可审计。
- 选型紧跟 2026 现状（Qwen3.5-Omni / Gemini 3.x），并保留传统管线作可解释基线。

---

## 五、逻辑与规范（Agent 进阶能力）

- **planning**：依据 `probe_media` 的时长决定单次或分片处理。
- **tool routing**：同一 `analyze_media` 按"事件/说话人/情感"目的路由不同指令；流程在
  探测→分析→合并→渲染间路由。
- **失败与异常**：重试、分片再切、降级经典管线、缺流降级，均在 SKILL.md 固化并由脚本支撑。
- **完整 pipeline + 过程证据**：`mini-agent run show <id> --format timeline/json` 与
  session JSONL 导出 Agent 规划与工具调用轨迹，作为过程文件提交。

---

## 六、复现实验与验证

```bash
npm run check                      # typecheck + 183 项测试
npm run dev -- doctor              # 查看 [multimodal_path] 等自检
# 应用一
npm run dev -- "把 tasks/demo 文件夹整编成情报报文"
# 应用二（需配置 MINI_AGENT_MM_MODEL 等）
npm run dev -- "分析 <media> 的事件、说话人与情感并出报告"
# 对比实验
python3 experiments/run_experiment.py
```

## 七、局限与展望

- 扩充测试集规模与片段类型；引入 LLM-judge 与帧级 DER 提升评测严谨性。
- 公文与分析报告的 docx/pdf 版式精排；增加任务级 Web 可视化。
- 多模态长视频的更智能分片与跨片说话人聚类。

## 附：交付物清单

- 源代码：`src/`（runtime + 媒体工具 + 多模态 helper）、两个 Skill（`.agents/skills/`）、
  对比实验（`experiments/`）。
- 过程文件：`docs/specs/`（两份 spec）、`docs/report/`（本报告）、运行时 run/session/trace。
- 测试：`tests/`（35 个测试文件、183 项）。
