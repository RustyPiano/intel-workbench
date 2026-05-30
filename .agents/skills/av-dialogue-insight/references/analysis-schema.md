# 分析 JSON schema 与提示词

`validate_analysis.py`、`merge_chunks.py` 与 `render_report.py` 消费如下结构。字段均可选，
但建议提供 `media`、`method`、`summary`、`events`、`speakers`、`emotion_timeline` 和
`key_triggers`。

```json
{
  "media": "meeting.mp3",
  "method": "doubao-asr",
  "duration_seconds": 95.0,
  "transcript": "经上下文校正后的完整转写……",
  "utterances": [
    { "start": "00:05", "end": "00:09", "speaker": "S1", "text": "欢迎大家。", "emotion": "neutral" }
  ],
  "summary": "整体多模态总结……",
  "degraded": false,
  "degraded_note": "",
  "events": [
    { "time": "00:05", "title": "会议开始", "detail": "主持人开场说明议程" }
  ],
  "speakers": [
    { "id": "S1", "label": "主持人", "talk_ratio": 0.45, "talk_seconds": 42.8, "profile": "语速平稳，主导议程" }
  ],
  "emotion_timeline": [
    { "time": "01:12", "speaker": "S2", "emotion": "angry", "valence": -0.6, "note": "语气升高、连续打断" }
  ],
  "key_triggers": [
    { "time": "01:12", "description": "预算方案被否决引发不满", "evidence": "转写内容 + 语气突变" }
  ]
}
```

- `method` 必须是 `"doubao-asr"`、`"omni"` 或 `"classic-pipeline"`。
- `transcript` 是给报告使用的校正后转写；ASR 结果可能有错，需结合上下文修正明显误识别。
- `utterances` 是面向报告的说话轮次，可由 `analyze_audio` 的 `utterances` 归一化而来。
- `time`/`start`/`end` 用 `MM:SS`，超过 1 小时用 `HH:MM:SS`；分片合并时由脚本转成绝对时间。
- `talk_ratio` 为该说话人话语时长占比，0~1；如有 `talk_seconds`，合并脚本优先用它重算占比。
- 只报告媒体中可听到或可观察到的信息。不要臆测真实身份、动机、不可见事实或未出现的因果。

## Doubao Emotion → Valence

| emotion | valence | note |
| --- | ---: | --- |
| angry | -0.6 | 负向，高冲突或不满 |
| sad | -0.5 | 负向，低落或失望 |
| neutral | 0 | 中性 |
| surprise | +0.1 | 轻微正向默认值，但语境可能正负皆可，需在 note 说明 |
| happy | +0.6 | 正向 |

未知情绪可保留原标签，`valence` 用上下文估计；不确定时设为 `0` 并在 `note` 标明。

## 推荐提示词

**音频 ASR 结果综合分析：**

> 根据已读取的 `analyze_audio` 结果文件和 `audio_stats.py` 统计，输出 JSON：
> media、method="doubao-asr"、duration_seconds、transcript、utterances(start,end,speaker,text,emotion)、
> summary、events(time,title,detail)、speakers(id,label,talk_ratio,talk_seconds,profile)、
> emotion_timeline(time,speaker,emotion,valence,note)、key_triggers(time,description,evidence)。
> 修正明显 ASR 误识别，但不要编造听不出的内容。

**视频/多模态综合分析：**

> 分析这段视频对话，输出同一 JSON schema，method="omni"。时间用 MM:SS，相对片段起点。
> 只基于可见/可听证据，不确定的身份、动机或原因写 unknown/pending verification。
