---
name: av-dialogue-insight
description: Analyze dialogue-heavy video/audio such as meeting recordings, interviews, calls, surveillance or captured conversation video, 会议录音, 访谈, 电话录音, 监控对话视频, 情绪时间线, and 关键触发点. Use when the user wants timestamped events, speaker profiles, multimodal emotion, trigger-point explanation, and a structured report. Do not use for generic image/video captioning without dialogue or conversation analysis.
compatibility: analyze_audio needs Doubao ASR config (MINI_AGENT_ASR_*); standard ASR needs a model-reachable URL or TOS for local files, while turbo ASR can send supported local audio inline. analyze_media needs MINI_AGENT_MM_MODEL. Use volcengine-media-setup when the user needs Doubao ASR or optional TOS configuration. probe_media needs ffprobe; scripts need Python 3.11+.
allowed-tools: read write edit bash activate_skill probe_media analyze_audio analyze_media
metadata:
  author: mini-agent
  version: "1.0.0"
---

# A/V Dialogue Insight

## When To Use

Use this skill for meeting recordings, interviews, calls, surveillance dialogue,
or other dialogue-heavy audio/video when the user needs a timestamped event
timeline, speaker profiles, emotion timeline, trigger-point explanation, and a
structured report.

## Layout

```
av-tasks/<task-id>/
  raw/        full tool result JSON written by media tools
  analysis/   derived analysis JSON, optional until a saved report is needed
  report/     rendered report (.md, optional .docx)
```

## Intent Calibration

When the user gives a broad request such as "分析这个音频", "分析这段录音",
"看一下这段对话", or only provides a media path, treat the analysis goal as
under-specified. Before choosing an ASR engine or producing a full report, it is
often better to ask a short clarifying question about the desired depth:

- basic transcript and summary
- speaker separation and timeline
- emotion / tone / conflict or trigger-point analysis
- evidence-style report with timestamps
- saved structured report

Keep the question lightweight. If the context already makes the user's goal
clear, proceed without asking. If the user seems to want a quick first pass,
turbo can be a reasonable choice for transcript and speaker separation; note
that rich emotion metadata may require standard ASR.

## Routing

1. **Audio path or URL:** choose `analyze_audio` after considering the user's
   requested depth, with an explicit `engine: "standard"` or `engine: "turbo"`.
   `turbo` is a good fit for quick transcription and speaker separation when
   the audio is wav/mp3/ogg/opus and within the turbo limits, whether it is a
   local file or a reachable URL. `standard` is a better fit when the user asks
   for rich metadata (emotion, gender, speech-rate, volume), long/large audio,
   or preservation of the original format.
   For local m4a/aac/flac/wma/amr/3gpp without rich metadata requirements,
   try converting with `ffmpeg` to a turbo-supported format before asking the
   user to configure TOS.
2. **Video or image:** call `probe_media` for local media, then
   `analyze_media({ path or url, kind, instruction, want_json: true })`. For
   reachable video URLs, provide `kind: "video"`.
3. Both media tools return their result inline by default. For long transcripts,
   pass `out_path: "av-tasks/<id>/raw/asr.json"` to persist the full result and
   read that file before analysis instead of carrying it in the conversation.

## Analysis Workflow

1. Take the media result from the tool output (or read `out_path` if you
   persisted it). For audio ASR, use `text` and `utterances`; for video, use the
   model text/JSON from `analyze_media`.
2. For reproducible speaker timing and emotion counts, persist the ASR result to
   `av-tasks/<id>/raw/asr.json` and run:
   `python3 .agents/skills/av-dialogue-insight/scripts/audio_stats.py av-tasks/<id>/raw/asr.json`
   Add `--offset-seconds <n>` when converting a chunk's relative utterance times
   to absolute media times.
3. Build the final analysis in-loop: correct likely transcript recognition
   errors using surrounding context, infer events and triggers only from audible
   or visible evidence, and mark uncertain identities or causes as
   `unknown`/`pending verification`.
4. If the user wants a saved report, write `av-tasks/<id>/analysis/analysis.json`
   using `references/analysis-schema.md`, then run:
   `python3 .agents/skills/av-dialogue-insight/scripts/validate_analysis.py av-tasks/<id>/analysis/analysis.json`
5. Render with:
   `python3 .agents/skills/av-dialogue-insight/scripts/render_report.py av-tasks/<id>/analysis/analysis.json av-tasks/<id>/report/report`
   Add `--docx` when the user asks for a Word document.

## Large Or Local Media

- Run `probe_media` first; its `inline_base64_allowed` tells you whether a local
  file fits the inline limit.
- Small local video/image (within the inline limit): pass `path` to
  `analyze_media` — it is sent inline as Base64.
- Local audio does not automatically require TOS. If turbo supports the format
  (or `ffmpeg` can convert it locally), it is usually a reasonable first-pass
  option for transcript and speaker separation, especially when the user did
  not ask for rich metadata.
- Use standard ASR for rich metadata, long/large audio, or formats you should
  preserve. For local files, standard ASR needs Volcano Engine TOS automatic upload
  or an existing model-reachable pre-signed URL. Activate
  `volcengine-media-setup` only when credentials, TOS setup, upload permission,
  cost, or privacy need user confirmation.

## Failure Handling

- Missing ASR configuration: activate `volcengine-media-setup` or ask for
  `MINI_AGENT_ASR_*`; Doubao ASR auth is separate from text and multimodal
  connections.
- Missing multimodal configuration: ask for `MINI_AGENT_MM_MODEL` and related
  connection settings.
- Invalid JSON: validate, retry once with the specific validation error, then
  produce a degraded report if needed.
- Transcript errors are expected; correct them with context and preserve
  uncertainty when the audio is ambiguous.

## Resources

- `references/analysis-schema.md` — final analysis JSON schema + emotion→valence table.
- `scripts/audio_stats.py` — deterministic talk ratio, emotion counts, absolute utterance times.
- `scripts/render_report.py` — analysis JSON to report.
- `scripts/validate_analysis.py` — validate or normalize analysis JSON.
