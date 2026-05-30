---
name: av-dialogue-insight
description: Analyze dialogue-heavy video/audio such as meeting recordings, interviews, calls, surveillance or captured conversation video, 会议录音, 访谈, 电话录音, 监控对话视频, 情绪时间线, and 关键触发点. Use when the user wants timestamped events, speaker profiles, multimodal emotion, trigger-point explanation, and a structured report. Do not use for generic image/video captioning without dialogue or conversation analysis.
compatibility: Requires a multimodal model (set MINI_AGENT_MM_MODEL, e.g. qwen3.5-omni-plus) for analyze_media, ffprobe for probe_media, and Python 3.11+ for the bundled scripts. The classic fallback uses ffmpeg + optional Whisper/pyannote.
allowed-tools: read write edit bash activate_skill probe_media analyze_media
metadata:
  author: mini-agent
  version: "1.0.0"
---

# A/V Dialogue Insight

## When to use

Use this skill to understand a meeting recording, interview, call, or captured
conversation: detect key events with timestamps, profile the speakers, track
emotion over time, and explain the key trigger points, then produce one report.

## Layout

```
av-tasks/<task-id>/
  analysis/   per-chunk and merged analysis JSON
  report/     rendered report (.md, optional .docx)
```

## Workflow

1. **Probe the media.** For local files, call `probe_media` and plan from
   `inlineBase64Allowed`, `recommendedTransport`, and
   `recommendedChunkSeconds`.
   - `recommendedTransport: "inline"`: analyze the local file directly.
   - `recommendedTransport: "split"`: run
     `python3 .agents/skills/av-dialogue-insight/scripts/split_media.py <media> av-tasks/<id>/chunks --seconds <recommendedChunkSeconds>`
     and analyze each chunk from the generated `chunks.json`.
   - If the user supplies a public URL, call `analyze_media` with `url` and
     explicit `kind`; audio URLs also require `format`.
2. **Analyze with the multimodal model.** For each (chunk of the) media, call
   `analyze_media` with `want_json: true`, routing by purpose — see
   `references/analysis-schema.md` for the exact prompts and target JSON:
   - events with `MM:SS` timestamps,
   - speaker turns and profiles,
   - emotion timeline and key trigger points.
   You may combine these into one instruction for short media, or issue
   separate calls and merge the JSON yourself. Keep claims grounded in visible
   or audible evidence; mark uncertain identities or causes as unknown/pending
   verification.
3. **Validate JSON.** Run
   `python3 .agents/skills/av-dialogue-insight/scripts/validate_analysis.py <analysis.json>`
   before merge/render. If validation fails, retry `analyze_media` once with a
   stricter instruction that names the bad fields; if it still fails, produce a
   degraded report.
4. **Merge chunks (if split).** Write each chunk's analysis JSON under
   `av-tasks/<id>/analysis/` and run
   `python3 .agents/skills/av-dialogue-insight/scripts/merge_chunks.py --manifest av-tasks/<id>/chunks/chunks.json --analysis-dir ../analysis av-tasks/<id>/analysis/merged.json`
   to shift timestamps into absolute time, deduplicate events, and reweight
   speaker ratios.
5. **Render the report.** Write the consolidated analysis JSON, then run
   `python3 .agents/skills/av-dialogue-insight/scripts/render_report.py av-tasks/<id>/analysis/merged.json av-tasks/<id>/report/report`
   (add `--docx` for a Word document).

## Failure & exception handling

- **Chunk still too large / model rejects it:** split further (halve the window)
  and retry.
- **Local Base64 payload exceeds 10MB:** split/compress the media or use a
  user-provided public URL before calling `analyze_media`.
- **Invalid JSON:** validate, retry once with the specific validation error,
  then degrade if the model still does not return usable JSON.
- **`analyze_media` fails (quota/network/timeout):** retry once; if it keeps
  failing on a local file, fall back to the classic pipeline:
  `python3 .agents/skills/av-dialogue-insight/scripts/fallback_pipeline.py <media> av-tasks/<id>/analysis/merged.json`
  (ffmpeg + Whisper + pyannote). The fallback marks the analysis `degraded` and
  the report shows a degradation banner. For URL-only input, ask for a local
  file before using the classic fallback.
- **No audio or no video stream (from `probe_media`):** proceed with the
  available modality and note the limitation in the summary.
- **Multimodal model not configured:** tell the user to set `MINI_AGENT_MM_MODEL`
  (and key/base-url), or use the classic fallback.

## Resources

- `references/analysis-schema.md` — analysis JSON schema + per-purpose prompts.
- `scripts/render_report.py` — analysis JSON → structured report.
- `scripts/merge_chunks.py` — merge per-chunk analysis with timestamp offsets.
- `scripts/split_media.py` — split local media and write `chunks.json`.
- `scripts/validate_analysis.py` — validate or normalize analysis JSON.
- `scripts/fallback_pipeline.py` — classic ffmpeg+Whisper+pyannote fallback.
