# Spec：音视频对话综合分析（av-dialogue-insight）

> Spec Coding 产物。对应作业选题（2）音视频场景分析 +（3）情感识别与对话分析的
> 合并应用。

## 1. 目标与范围

输入一段音视频/音频对话，由 Agent 自主规划并编排完整 pipeline，产出含
**事件时间线（带时间戳）、说话人画像、情感时间线、关键触发点、多模态总结**的结构化
报告，覆盖：视频内容理解、关键事件检测与时间定位、多模态总结（选题2）；说话人分析、
对话行为、多模态情感、关键触发点解释（选题3）。

## 2. 媒体接入（B 方案：专用工具）

文本 runtime 不变，媒体封装在工具内，绕过文本 `RuntimeMessage`。视频/图像走
`src/model/multimodal.ts` 的 `callOmni`；纯音频走 Doubao 录音文件识别
`volc.seedasr.auc`，由 ASR 客户端异步 submit → poll 后归一化。

| 工具 | 入参 | 行为 |
| --- | --- | --- |
| `probe_media` | `{path}` | ffprobe 取时长/流/分辨率与本地 inline 规划（`inlineBase64Allowed` 等），判断单次 inline 是否可行 |
| `analyze_media` | `{path?, url?, kind?, format?, instruction, want_json?, out_path?}` | 调多模态模型分析视频/图像/音频；默认内联返回分析，给 `out_path` 时改为写文件 + 短摘要。必须且只能提供 `path` 或 `url`；URL 需要 `kind` |
| `analyze_audio` | `{path?, url?, format?, engine, out_path?, language?, speaker?, emotion?, hotwords?, advanced?}` | 调 Doubao ASR 分析音频；`engine` 必须显式为 `standard` 或 `turbo`。turbo 可内联支持格式的本地音频；standard 使用公网 URL/TOS 并返回更完整元数据。默认内联返回 transcript/utterances，给 `out_path` 时写完整结果（含 raw 提供方载荷）+ 短摘要 |

连接配置：`mmProvider/mmModel/mmBaseURL/mmApiKey`（`MINI_AGENT_MM_*`）。运行时没有默认
多模态模型；推荐示例是 Qwen3.5-Omni（DashScope，OpenAI 兼容）。`baseURL/apiKey`
缺省回退主连接。
`MINI_AGENT_MM_TIMEOUT_MS` 可为长媒体分析设置独立超时，避免被通用工具超时截断。

ASR 配置独立于文本与多模态连接，不回退主连接：`MINI_AGENT_ASR_API_KEY`，或
`MINI_AGENT_ASR_APP_KEY` + `MINI_AGENT_ASR_ACCESS_KEY`。可选
`MINI_AGENT_ASR_APP_ID`、`MINI_AGENT_ASR_RESOURCE_ID`（默认 `volc.seedasr.auc`）、
`MINI_AGENT_ASR_BASE_URL`（默认 `https://openspeech.bytedance.com`）、
`MINI_AGENT_ASR_TIMEOUT_MS`。本地音频不一定需要上传：Agent 可为快速转写选择
turbo，并在格式不兼容且不需要丰富元数据时先用 `ffmpeg` 转为 wav/mp3/ogg/opus。
standard 引擎用于丰富元数据、长/大音频或保留原格式，需公网 URL 或上传到私有 TOS 后
使用短时预签名 URL。

`analyze_media` 与 `analyze_audio` 默认把结果内联返回（适合图片/短片段）；当 Agent 给出
`out_path` 时改为把完整结果（`analyze_audio` 含 raw 提供方载荷）写入文件、tool message 只
回短摘要、路径与小型统计，适合长转写以保持上下文精简。

## 3. 分析 JSON 数据契约

`method / transcript / utterances / events / speakers / emotion_timeline / key_triggers / summary / degraded`，时间用
`MM:SS`，valence ∈ [-1,1]，`method` 为 `doubao-asr` 或 `omni`。完整 schema 见
`.agents/skills/av-dialogue-insight/references/analysis-schema.md`。

## 4. Pipeline（planning + tool routing + 完整流程）

1. 纯音频 → `analyze_audio({ path|url, format?, engine })` → 用返回的
   `text`/`utterances`（或给 `out_path` 落盘后读取）。Agent 根据目标显式选择引擎：
   `turbo` 用于快速转写/说话人分离和支持格式的本地 inline；`standard` 用于丰富元数据、
   长/大音频或保留原格式，并需要公网 URL 或已配置 TOS。可把 ASR 结果存盘后运行
   `audio_stats.py` 得到可复现的说话人占比与情绪计数。ASR 可能有识别错误，Agent 结合
   上下文修正明显误识别后再产出报告。
2. 视频/图像 → `probe_media` → 取时长/大小 → 据 `inlineBase64Allowed` 规划：本地文件
   Base64 编码后小于 10MB 时可单次 inline（传 `path`）；超限本地文件可根据配置和意图
   选择 TOS/已有可达 URL、压缩或切片。
3. `analyze_media`（按需 `want_json`、`out_path`），按目的路由：事件 / 说话人 / 情感+触发点。
   结构化输出采用 prompt-plus-parse，不依赖 `response_format`。
4. 需要落盘报告时：按 schema 写 `analysis.json` → `validate_analysis.py` 校验/可选
   normalize（失败重试一次再降级）→ `render_report.py` 渲染时间线表/说话人表/情感时间线/
   触发点/总结。

## 5. 失败与异常处理策略

- 本地文件超过 inline 上限（Base64 > 10MB）或被模型拒绝 → 压缩，或上传公网存储（火山 TOS）
  取 URL 后改用 URL 输入。
- `analyze_audio` submit/poll 超时 → 增大 `asrTimeoutMs` 或缩短音频；ASR 鉴权失败需检查
  `MINI_AGENT_ASR_*`，该鉴权与文本/mm 连接分离。
- `analyze_media` 配额/网络/超时失败 → 重试一次；仍失败则按可用证据输出降级报告（标 `degraded`）。
- 模型返回不可解析或校验不通过的 JSON → 补充更严格的字段要求重试一次；仍失败则输出降级报告。
- 缺音/缺视频流 → 以可用模态继续并在总结标注。
- 未配置多模态模型 → 提示设置 `MINI_AGENT_MM_*`（视频）/ `MINI_AGENT_ASR_*`（音频）。

## 6. 验收标准

- `analyze_media` 请求构造/JSON 解析/错误包装/未配置守卫，以及内联与 `out_path` 两种返回
  （`tests/unit/multimodal.test.ts`、`tests/unit/analyze-media.test.ts`）。
- `analyze_audio` Doubao ASR 归一化、submit→poll、内联/`out_path` 契约与超时
  （`tests/unit/asr.test.ts`、`tests/unit/analyze-audio.test.ts`）。
- `probe_media` 真实解析（有 ffmpeg 时）与错误路径（`tests/unit/probe-media.test.ts`）。
- 渲染确定性、`audio_stats` 可复现统计、analysis 校验（`tests/integration/av-dialogue-scripts.test.ts`）。
- Agent 端到端激活技能并渲染出期望报告（`tests/integration/av-dialogue-readiness.test.ts`）。
