# 对比实验：音视频对话分析方法

对比三种方法在"事件检测与时间定位、说话人分析、多模态情感、对话总结"上的表现，
用于评估 `av-dialogue-insight` 方案的有效性与先进性。

## 方法

1. **qwen-omni** — `analyze_media` 调用 Qwen3.5-Omni（DashScope，原生全模态）。
2. **gemini** — Gemini 3.x 原生视频理解（作为先进性对比）。
3. **classic-pipeline** — `scripts/fallback_pipeline.py`：ffmpeg + Whisper + pyannote
   （传统方法基线，仅转写+说话人，无多模态情感/触发点）。

## 目录约定

```
experiments/
  dataset/<clip>/ground_truth.json   人工标注的参考分析（av-dialogue 分析 JSON 结构）
  results/<method>/<clip>.json       各方法产出的分析 JSON
  metrics.py                         指标函数（纯函数，可离线测试）
  run_experiment.py                  跑批 + 制表
  report.md                          生成的对比报告
```

方法名即 `results/` 下的子目录名，新增方法 = 放入其产出目录即可。

## 准备数据

1. 采集若干短片段（会议片段、影视片段、现场对话录音），放在可访问路径。
2. 为每个片段在 `dataset/<clip>/ground_truth.json` 写人工标注：关键事件+时间戳、
   说话人、情感时间线（含 valence）、概要。结构见
   `.agents/skills/av-dialogue-insight/references/analysis-schema.md`。

## 产出各方法结果

- **qwen-omni**：用 agent 跑 `av-dialogue-insight`（配置 `MINI_AGENT_MM_MODEL=qwen3.5-omni-plus`），
  把合并后的分析 JSON 存到 `results/qwen-omni/<clip>.json`。
- **gemini**：配置 Gemini 端点/模型同样跑 `analyze_media`，存到 `results/gemini/<clip>.json`。
- **classic-pipeline**：
  `python3 .agents/skills/av-dialogue-insight/scripts/fallback_pipeline.py <media> experiments/results/classic-pipeline/<clip>.json`。

## 计算指标并制表

```bash
python3 experiments/run_experiment.py --tol 3
```

生成 `experiments/report.md`：

- **事件检测**：±tol 秒内贪心一一匹配，给出 precision/recall/F1。
- **情感**：时间匹配后标签准确率 + 效价 MAE。
- **说话人**：人数完全匹配率 + 计数误差。
- **概要**：字符二元组重合 F1（粗略代理；更可靠的质量评估建议用 LLM-judge）。
- **降级**：标记 `degraded` 的结果数。

仓库内已附 `dataset/meeting-clip` 与三方法的示例 `results/`，可直接运行查看样例报告。

## 说明与局限

- 概要重合 F1 仅为词面代理，不能完全反映语义质量；正式报告建议补充 LLM-judge 或人工评分。
- 完整说话人分离 DER 需帧级参考（RTTM），可用 pyannote 的 `DiarizationErrorRate`
  在有 RTTM 标注时单独计算；本harness先用人数匹配作轻量代理。
- 时间容差 `--tol` 可调；事件密集的素材建议收紧到 1~2s。
