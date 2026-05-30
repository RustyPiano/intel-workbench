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
| `probe_media` | `{path}` | ffprobe 取时长/流/分辨率/本地 inline 规划，供分片规划 |
| `analyze_media` | `{path?, url?, kind?, format?, instruction, want_json?, out_path}` | 调多模态模型分析视频/图像，完整结果写入 `out_path`，返回短摘要和路径。必须且只能提供 `path` 或 `url`；URL 需要 `kind` |
| `analyze_audio` | `{url, format, out_path, language?, speaker?, emotion?, hotwords?, advanced?}` | 调 Doubao ASR 分析公网音频 URL，完整 transcript/utterances/raw 写入 `out_path`，返回短摘要和路径 |

连接配置：`mmProvider/mmModel/mmBaseURL/mmApiKey`（`MINI_AGENT_MM_*`）。运行时没有默认
多模态模型；推荐示例是 Qwen3.5-Omni（DashScope，OpenAI 兼容）。`baseURL/apiKey`
缺省回退主连接。
`MINI_AGENT_MM_TIMEOUT_MS` 可为长媒体分析设置独立超时，避免被通用工具超时截断。

ASR 配置独立于文本与多模态连接，不回退主连接：`MINI_AGENT_ASR_API_KEY`，或
`MINI_AGENT_ASR_APP_KEY` + `MINI_AGENT_ASR_ACCESS_KEY`。可选
`MINI_AGENT_ASR_APP_ID`、`MINI_AGENT_ASR_RESOURCE_ID`（默认 `volc.seedasr.auc`）、
`MINI_AGENT_ASR_BASE_URL`（默认 `https://openspeech.bytedance.com`）、
`MINI_AGENT_ASR_TIMEOUT_MS`。ASR 仅支持公网音频 URL + `format`；本地音频上传是 TODO。

`analyze_media` 与 `analyze_audio` 都采用 write-to-file 契约：Agent 指定 `out_path`，
工具把完整结果写入文件，tool message 只包含短摘要、路径与小型统计，避免把大段转写或 JSON
塞进上下文。

## 3. 分析 JSON 数据契约

`method / transcript / utterances / events / speakers / emotion_timeline / key_triggers / summary / degraded`，时间用
`MM:SS`，valence ∈ [-1,1]。完整 schema 与 analyze_media 提示词见
`.agents/skills/av-dialogue-insight/references/analysis-schema.md`。

## 4. Pipeline（planning + tool routing + 完整流程）

1. 纯音频公网 URL → `analyze_audio(url, format, out_path)` → 读取写出的 ASR JSON；
   可运行 `audio_stats.py` 得到可复现的说话人占比与情绪计数。ASR 可能有识别错误，
   Agent 结合上下文修正明显误识别后再产出报告。
2. 视频/图像 → `probe_media` → 取时长/大小 → 根据 `inlineBase64Allowed`、
   `recommendedTransport`、`recommendedChunkSeconds` 规划。本地 Base64 编码后小于
   10MB 时可单次 inline；超限本地文件用 `split_media.py` 分片或先压缩。若用户已提供
   公网 URL，可直接走 URL 输入；仓库不自动上传 OSS。
3. 逐片 `analyze_media`（`want_json`, `out_path`），按目的路由：事件 / 说话人 / 情感+触发点。
   结构化输出采用 prompt-plus-parse，不依赖 `response_format`。
4. `validate_analysis.py` 校验/可选 normalize 每片 JSON；失败重试一次，再降级。
5. `merge_chunks.py` 可读 `chunks.json` manifest，按片偏移对齐时间戳、去重事件、按时长重算说话人占比。
6. `render_report.py` 渲染时间线表/说话人表/情感时间线/触发点/总结。

## 5. 失败与异常处理策略

- 分片仍过大、Base64 超过 10MB 或被模型拒绝 → 二分再切/压缩后重试；已有公网 URL 时可改用 URL 输入。
- `analyze_audio` submit/poll 超时 → 增大 `asrTimeoutMs` 或缩短音频；ASR 鉴权失败需检查
  `MINI_AGENT_ASR_*`，该鉴权与文本/mm 连接分离。
- `analyze_media` 配额/网络/超时失败 → 重试一次；持续失败则降级到
  `fallback_pipeline.py`（ffmpeg+Whisper+pyannote），分析标 `degraded`、报告显降级横幅。
- 模型返回不可解析或校验不通过的 JSON → 补充更严格的字段要求重试一次；仍失败则输出降级报告。
- 缺音/缺视频流 → 以可用模态继续并在总结标注。
- 未配置多模态模型 → 提示设置 `MINI_AGENT_MM_*` 或改用经典管线。

## 6. 验收标准

- `analyze_media` 请求构造/JSON 解析/错误包装/未配置守卫（`tests/unit/multimodal.test.ts`、
  `tests/unit/analyze-media.test.ts`）。
- `analyze_audio` Doubao ASR 归一化、submit→poll、写文件契约与超时（`tests/unit/asr.test.ts`、
  `tests/unit/analyze-audio.test.ts`）。
- `probe_media` 真实解析（有 ffmpeg 时）与错误路径（`tests/unit/probe-media.test.ts`）。
- 渲染确定性、分片合并时间偏移、audio_stats 可复现统计、降级不崩溃（`tests/integration/av-dialogue-scripts.test.ts`）。
- Agent 端到端激活技能并渲染出期望报告（`tests/integration/av-dialogue-readiness.test.ts`）。
