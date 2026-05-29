# Spec：音视频对话综合分析（av-dialogue-insight）

> Spec Coding 产物。对应作业选题（2）音视频场景分析 +（3）情感识别与对话分析的
> 合并应用。

## 1. 目标与范围

输入一段音视频/音频对话，由 Agent 自主规划并编排完整 pipeline，产出含
**事件时间线（带时间戳）、说话人画像、情感时间线、关键触发点、多模态总结**的结构化
报告，覆盖：视频内容理解、关键事件检测与时间定位、多模态总结（选题2）；说话人分析、
对话行为、多模态情感、关键触发点解释（选题3）。

## 2. 多模态接入（B 方案：专用工具）

文本 runtime 不变，多模态封装在工具内（`src/model/multimodal.ts` 的 `callOmni` 构造
OpenAI 兼容多模态 content parts，绕过文本 `RuntimeMessage`）。

| 工具 | 入参 | 行为 |
| --- | --- | --- |
| `probe_media` | `{path}` | ffprobe 取时长/流/分辨率，供分片规划 |
| `analyze_media` | `{path, instruction, want_json?}` | 调多模态模型分析，返回文本或解析后的 JSON |

连接配置：`mmProvider/mmModel/mmBaseURL/mmApiKey`（`MINI_AGENT_MM_*`），默认指向
Qwen3.5-Omni（DashScope，OpenAI 兼容）；`baseURL/apiKey` 缺省回退主连接。

## 3. 分析 JSON 数据契约

`events / speakers / emotion_timeline / key_triggers / summary / degraded`，时间用
`MM:SS`，valence ∈ [-1,1]。完整 schema 与 analyze_media 提示词见
`.agents/skills/av-dialogue-insight/references/analysis-schema.md`。

## 4. Pipeline（planning + tool routing + 完整流程）

1. `probe_media` → 取时长 → 规划：≤~360s 单次；否则按 300s 分片（ffmpeg 切片）。
2. 逐片 `analyze_media`（`want_json`），按目的路由：事件 / 说话人 / 情感+触发点。
3. `merge_chunks.py` 按片偏移对齐时间戳、归并说话人。
4. `render_report.py` 渲染时间线表/说话人表/情感时间线/触发点/总结。

## 5. 失败与异常处理策略

- 分片仍过大或被模型拒绝 → 二分再切重试。
- `analyze_media` 配额/网络/超时失败 → 重试一次；持续失败则降级到
  `fallback_pipeline.py`（ffmpeg+Whisper+pyannote），分析标 `degraded`、报告显降级横幅。
- 缺音/缺视频流 → 以可用模态继续并在总结标注。
- 未配置多模态模型 → 提示设置 `MINI_AGENT_MM_*` 或改用经典管线。

## 6. 验收标准

- `analyze_media` 请求构造/JSON 解析/错误包装/未配置守卫（`tests/unit/multimodal.test.ts`、
  `tests/unit/analyze-media.test.ts`）。
- `probe_media` 真实解析（有 ffmpeg 时）与错误路径（`tests/unit/probe-media.test.ts`）。
- 渲染确定性、分片合并时间偏移、降级不崩溃（`tests/integration/av-dialogue-scripts.test.ts`）。
- Agent 端到端激活技能并渲染出期望报告（`tests/integration/av-dialogue-readiness.test.ts`）。
