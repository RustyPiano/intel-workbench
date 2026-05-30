---
name: av-dialogue-insight
description: Analyze dialogue-heavy video/audio such as meeting recordings, interviews, calls, surveillance or captured conversation video, 会议录音, 访谈, 电话录音, 监控对话视频, 情绪时间线, and 关键触发点. Use when the user wants timestamped events, speaker profiles, multimodal emotion, trigger-point explanation, and a structured report. Do not use for generic image/video captioning without dialogue or conversation analysis.
compatibility: Audio URLs require analyze_audio with Doubao ASR configuration; video/image uses analyze_media with MINI_AGENT_MM_MODEL. Local audio upload is TODO/URL-only for now. probe_media requires ffprobe; scripts require Python 3.11+.
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

## Routing

1. **Public audio URL:** call
   `analyze_audio({ url, format, out_path: "av-tasks/<id>/raw/asr.json" })`.
   Audio is URL-only for now; local audio publishing/upload is an explicit TODO.
2. **Video or image:** call `probe_media` for local media, then
   `analyze_media({ path or url, kind, instruction, want_json: true, out_path: "av-tasks/<id>/raw/media.json" })`.
   For public video URLs, provide `kind: "video"` and still name `out_path`.
3. Both media tools write the full result to the `out_path` you name and return
   only a short summary. Read the written file before analysis; do not expect
   large transcripts, utterances, model text, or parsed JSON inline.

## Analysis Workflow

1. Read the media result file. For audio ASR, use `transcript`/`text` and
   `utterances`; for video, use the model text/JSON from `analyze_media`.
2. For reproducible speaker timing and emotion counts, run:
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

## Long Or Local Media

- For large local video, use `probe_media`; if it recommends splitting, run
  `split_media.py`, analyze each chunk to its own `out_path`, then use
  `merge_chunks.py` after validating per-chunk analysis JSON.
- Local audio is not uploaded automatically. Ask for a public URL or note the
  TODO for a future publish-media helper.
- If `analyze_media` repeatedly fails for local video/audio, the classic
  fallback is:
  `python3 .agents/skills/av-dialogue-insight/scripts/fallback_pipeline.py <media> av-tasks/<id>/analysis/analysis.json`
  The fallback is degraded and requires local ffmpeg plus optional
  Whisper/pyannote.

## Failure Handling

- Missing ASR configuration: ask for `MINI_AGENT_ASR_*`; Doubao ASR auth is
  separate from text and multimodal connections.
- Missing multimodal configuration: ask for `MINI_AGENT_MM_MODEL` and related
  connection settings.
- Invalid JSON: validate, retry once with the specific validation error, then
  produce a degraded report if needed.
- Transcript errors are expected; correct them with context and preserve
  uncertainty when the audio is ambiguous.

## Resources

- `references/analysis-schema.md` — final analysis JSON schema and prompts.
- `scripts/audio_stats.py` — deterministic talk ratio, emotion counts, absolute utterance times.
- `scripts/render_report.py` — analysis JSON to report.
- `scripts/merge_chunks.py` — merge per-chunk analysis with timestamp offsets.
- `scripts/split_media.py` — split local media and write `chunks.json`.
- `scripts/validate_analysis.py` — validate or normalize analysis JSON.
