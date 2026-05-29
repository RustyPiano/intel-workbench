# 分析 JSON schema 与 analyze_media 提示词

`render_report.py` 与 `merge_chunks.py` 消费如下结构（字段均可选，`media` 建议提供）：

```json
{
  "media": "meeting.mp4",
  "duration_seconds": 95.0,
  "summary": "整体多模态总结……",
  "degraded": false,
  "degraded_note": "",
  "events": [
    { "time": "00:05", "title": "会议开始", "detail": "主持人开场说明议程" }
  ],
  "speakers": [
    { "id": "S1", "label": "主持人", "talk_ratio": 0.45, "profile": "语速平稳，主导议程" }
  ],
  "emotion_timeline": [
    { "time": "01:12", "speaker": "S2", "emotion": "anger", "valence": -0.6, "note": "语气升高、皱眉" }
  ],
  "key_triggers": [
    { "time": "01:12", "description": "预算方案被否决引发不满", "evidence": "语气突变 + 表情变化" }
  ]
}
```

- `time` 用 `MM:SS`（超过 1 小时用 `HH:MM:SS`），相对该片段起点；分片合并时由
  `merge_chunks.py` 加偏移转为绝对时间。
- `valence` 为情感效价，取值 -1.0（极负）~ +1.0（极正）。
- `talk_ratio` 为该说话人话语时长占比，0~1。

## 推荐的 analyze_media 提示词（want_json: true）

**一次性综合分析（短媒体）：**

> 分析这段音视频对话。返回 JSON：media、duration_seconds、summary、
> events(time MM:SS, title, detail)、speakers(id,label,talk_ratio,profile)、
> emotion_timeline(time,speaker,emotion,valence -1~1,note)、
> key_triggers(time,description,evidence)。时间用 MM:SS，相对片段起点。

**分目的路由（长媒体或需精细控制时分别调用）：**

- 事件：「列出关键事件，每条含 MM:SS 时间戳、标题、说明，输出 JSON 数组 events。」
- 说话人：「区分说话人并给出 id、标签、话语占比、画像，输出 JSON 数组 speakers。」
- 情感：「逐段给出说话人情感（含 valence -1~1 与依据），并标注关键触发点，
  输出 JSON：emotion_timeline、key_triggers。」
