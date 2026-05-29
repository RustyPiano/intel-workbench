---
name: av-dialogue-insight
description: Analyze a video/audio recording for events with timestamps, speaker profiles, multimodal emotion, and key trigger points, then render a structured report. Combines media understanding and dialogue analysis.
compatibility: Requires a multimodal model (set MINI_AGENT_MM_MODEL, e.g. qwen3.5-omni-plus) for analyze_media, ffprobe for probe_media, and Python 3.11+ for the bundled scripts. The classic fallback uses ffmpeg + optional Whisper/pyannote.
allowed-tools: read write edit bash activate_skill probe_media analyze_media
metadata:
  author: mini-agent
  version: "1.0.0"
---

# A/V Dialogue Insight

## When to use

Use this skill to understand a meeting recording, film clip, or captured
conversation: detect key events with timestamps, profile the speakers, track
emotion over time, and explain the key trigger points — then produce one report.

## Layout

```
av-tasks/<task-id>/
  analysis/   per-chunk and merged analysis JSON
  report/     rendered report (.md, optional .docx)
```

## Workflow

1. **Probe the media.** Call `probe_media` with the file path. Note the
   duration and whether it has video/audio streams. Plan from this:
   - If duration ≤ ~360s, analyze in one pass.
   - If longer, split into chunks (e.g. 300s each) with `bash` + ffmpeg
     (`ffmpeg -i in.mp4 -ss <start> -t <len> -c copy chunkN.mp4`) and analyze each.
2. **Analyze with the multimodal model.** For each (chunk of the) media, call
   `analyze_media` with `want_json: true`, routing by purpose — see
   `references/analysis-schema.md` for the exact prompts and target JSON:
   - events with `MM:SS` timestamps,
   - speaker turns and profiles,
   - emotion timeline and key trigger points.
   You may combine these into one instruction for short media, or issue
   separate calls and merge the JSON yourself.
3. **Merge chunks (if split).** Write each chunk's analysis JSON under
   `av-tasks/<id>/analysis/` and run
   `python3 .agents/skills/av-dialogue-insight/scripts/merge_chunks.py av-tasks/<id>/analysis/merged.json 0:chunk0.json 300:chunk1.json …`
   to shift timestamps into absolute time and unify speakers.
4. **Render the report.** Write the consolidated analysis JSON, then run
   `python3 .agents/skills/av-dialogue-insight/scripts/render_report.py av-tasks/<id>/analysis/merged.json av-tasks/<id>/report/report`
   (add `--docx` for a Word document).

## Failure & exception handling

- **Chunk still too large / model rejects it:** split further (halve the window)
  and retry.
- **`analyze_media` fails (quota/network/timeout):** retry once; if it keeps
  failing, fall back to the classic pipeline:
  `python3 .agents/skills/av-dialogue-insight/scripts/fallback_pipeline.py <media> av-tasks/<id>/analysis/merged.json`
  (ffmpeg + Whisper + pyannote). The fallback marks the analysis `degraded` and
  the report shows a degradation banner.
- **No audio or no video stream (from `probe_media`):** proceed with the
  available modality and note the limitation in the summary.
- **Multimodal model not configured:** tell the user to set `MINI_AGENT_MM_MODEL`
  (and key/base-url), or use the classic fallback.

## Resources

- `references/analysis-schema.md` — analysis JSON schema + per-purpose prompts.
- `scripts/render_report.py` — analysis JSON → structured report.
- `scripts/merge_chunks.py` — merge per-chunk analysis with timestamp offsets.
- `scripts/fallback_pipeline.py` — classic ffmpeg+Whisper+pyannote fallback.
