# Multimodal Hardening Then Skill Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make the multimodal media tools reliable for real DashScope/Qwen-Omni usage first, then simplify the skills so they describe only supported, deterministic workflows.

**Architecture:** Keep the runtime text-only. Multimodal bytes, URLs, provider request shapes, and media planning stay inside tools/model helpers; the agent loop receives only text, parsed JSON, and tool metadata. Skill instructions are updated only after the underlying tool behavior exists and is covered by tests.

**Tech Stack:** TypeScript, Vitest, OpenAI-compatible Chat Completions SDK, ffprobe/ffmpeg, Python 3 scripts for deterministic media workflow steps.

**Provider Contract References:**
- Qwen Cloud audio/video file understanding: https://docs.qwencloud.com/developer-guides/speech/multimodal-speech
- Alibaba Cloud Qwen-Omni: https://www.alibabacloud.com/help/en/model-studio/qwen-omni

---

## Phase 1: Hardware - Tool And Runtime Capabilities

### Task 1: Make The Media Source And Provider Contract Explicit

**Files:**
- Create: `src/model/media-source.ts`
- Modify: `src/model/multimodal.ts`
- Modify: `src/tools/analyze-media.ts`
- Test: `tests/unit/multimodal.test.ts`
- Test: `tests/unit/analyze-media.test.ts`
- Test: `tests/unit/tool-registry.test.ts`

- [x] **Step 1: Write failing request-builder tests**
  - `callOmni` with `{ type: "file", path }` preserves current small-file inline Base64 behavior.
  - Video URL builds:
    ```ts
    { type: "video_url", video_url: { url: "https://example.com/clip.mp4" } }
    ```
  - Image URL builds:
    ```ts
    { type: "image_url", image_url: { url: "https://example.com/frame.png" } }
    ```
  - Audio URL builds:
    ```ts
    { type: "input_audio", input_audio: { data: "https://example.com/talk.wav", format: "wav" } }
    ```
  - Every URL and file request still sets:
    ```ts
    {
      modalities: ["text"],
      stream: true,
      stream_options: { include_usage: true }
    }
    ```

- [x] **Step 2: Write failing strict tool-schema tests**
  - `analyze_media` accepts URL-only arguments:
    ```json
    { "path": null, "url": "https://example.com/clip.mp4", "kind": "video", "format": null, "instruction": "Summarize", "want_json": null }
    ```
  - `analyze_media` accepts path-only arguments:
    ```json
    { "path": "clip.mp4", "url": null, "kind": null, "format": null, "instruction": "Summarize", "want_json": null }
    ```
  - `analyze_media` rejects both `path` and `url`.
  - `analyze_media` rejects neither `path` nor `url`.
  - `analyze_media` rejects URL source without `kind`.
  - `analyze_media` rejects audio URL without `format`.
  - `analyze_media` rejects unsupported `kind` and unsupported audio `format`.
  - Include one `ToolRegistry.execute` test so the OpenAI strict-mode nullable optional behavior is covered end-to-end.

- [x] **Step 3: Implement explicit types**
  - Create `MediaSource` as a discriminated union:
    ```ts
    export type UrlMediaSource =
      | { type: "url"; url: string; kind: "video" }
      | { type: "url"; url: string; kind: "image" }
      | { type: "url"; url: string; kind: "audio"; format: string };

    export type FileMediaSource = { type: "file"; path: string };
    export type MediaSource = FileMediaSource | UrlMediaSource;
    ```
  - Keep URL `kind` required. Do not infer kind from a URL in this pass; signed URLs and query strings make extension inference unreliable.
  - For audio URL, require explicit `format` from the tool input.

- [x] **Step 4: Implement deterministic content builders**
  - File source:
    - Detect kind from local extension.
    - Enforce inline Base64 size limit before reading.
    - Audio/video local Base64 use `data:;base64,...`.
    - Image local Base64 keeps MIME type.
  - URL source:
    - `kind: "video"` uses `video_url.url`.
    - `kind: "image"` uses `image_url.url`.
    - `kind: "audio"` uses `input_audio.data` plus `format`.
  - Preserve the existing prompt-plus-parse behavior for `want_json`; do not add `response_format`.

- [x] **Step 5: Update `analyze_media` metadata**
  - Replace `meta.path`-only output with a source-aware shape:
    ```ts
    meta: {
      source: { type: "file", path: filePath } | { type: "url", url, kind, format? },
      kind: result.kind,
      model: result.model,
      json: result.json,
      usage: result.usage
    }
    ```
  - Keep `content` as the model text.

- [x] **Step 6: Verify**
  - Run: `npm run test:run -- tests/unit/multimodal.test.ts tests/unit/analyze-media.test.ts tests/unit/tool-registry.test.ts`
  - Expected: all targeted tests pass.

### Task 2: Add Multimodal-Specific Timeout

**Files:**
- Modify: `src/runtime/config.ts`
- Modify: `src/tools/types.ts`
- Modify: `src/tools/index.ts`
- Modify: `src/cli/doctor.ts`
- Modify: `src/cli/main.ts`
- Test: `tests/unit/config.test.ts`
- Test: `tests/unit/tool-registry.test.ts`
- Test: `tests/unit/cli-doctor.test.ts`

- [x] **Step 1: Write failing tests**
  - `MINI_AGENT_MM_TIMEOUT_MS=180000` resolves into runtime config.
  - `MINI_AGENT_MM_TIMEOUT_MS=0`, negative values, non-integers, and non-numeric values are ignored and leave `mmTimeoutMs` undefined.
  - `analyze_media` uses `mmTimeoutMs` instead of the default `toolTimeoutMs`.
  - The timeout error message for `analyze_media` reports the multimodal timeout value.
  - `doctor` prints the configured multimodal timeout.

- [x] **Step 2: Implement config**
  - Add `mmTimeoutMs?: number` to `RuntimeConfig` and `ToolRuntimeConfig`.
  - Parse `MINI_AGENT_MM_TIMEOUT_MS` as a positive integer only.
  - Do not change existing numeric environment parsing for unrelated settings unless tests require it.

- [x] **Step 3: Implement timeout selection**
  - In `ToolRegistry.execute`, select timeout with:
    ```ts
    const timeoutMs =
      tool.name === "analyze_media" && ctx.config.mmTimeoutMs
        ? ctx.config.mmTimeoutMs
        : ctx.config.toolTimeoutMs;
    ```
  - Use `timeoutMs` consistently in the timer and timeout message.

- [x] **Step 4: Verify**
  - Run: `npm run test:run -- tests/unit/config.test.ts tests/unit/tool-registry.test.ts tests/unit/cli-doctor.test.ts`
  - Expected: all targeted tests pass.

### Task 3: Make Probe Output Actionable With Shared Media Limits

**Files:**
- Create: `src/model/media-limits.ts`
- Modify: `src/model/multimodal.ts`
- Modify: `src/tools/probe-media.ts`
- Test: `tests/unit/multimodal.test.ts`
- Test: `tests/unit/probe-media.test.ts`

- [x] **Step 1: Write failing helper tests**
  - `base64EncodedLength(0) === 0`.
  - `base64EncodedLength(1) === 4`.
  - `base64EncodedLength(3) === 4`.
  - `base64EncodedLength(4) === 8`.
  - `MAX_INLINE_BASE64_BYTES` is exported from one shared helper.

- [x] **Step 2: Write failing probe planner tests**
  - Small local media returns:
    ```json
    {
      "inlineBase64Allowed": true,
      "recommendedTransport": "inline",
      "recommendedChunkSeconds": null
    }
    ```
  - Oversized local media returns:
    ```json
    {
      "inlineBase64Allowed": false,
      "recommendedTransport": "model_reachable_url_or_preprocess",
      "recommendedChunkSeconds": 300
    }
    ```
  - Tests should use a pure planner helper for sizes where possible; do not create large real media files just to test planning.

- [x] **Step 3: Implement planner fields**
  - Return:
    ```ts
    inlineBase64Bytes: number | null;
    inlineBase64Allowed: boolean | null;
    recommendedTransport: "inline" | "model_reachable_url_or_preprocess";
    recommendedChunkSeconds: number | null;
    ```
  - Oversized local media may use a model-reachable URL/TOS, compression, or chunking depending on current config and user intent.

- [x] **Step 4: Update summary text**
  - Include encoded size and recommendation in the tool content so the model can plan without inspecting `meta`.

- [x] **Step 5: Verify**
  - Run: `npm run test:run -- tests/unit/multimodal.test.ts tests/unit/probe-media.test.ts`
  - Expected: all targeted tests pass.

### Task 4: Add Deterministic Media Splitting

**Files:**
- Create: `.agents/skills/av-dialogue-insight/scripts/split_media.py`
- Test: `tests/integration/av-dialogue-scripts.test.ts`

- [x] **Step 1: Write failing integration test**
  - Skip when either `ffmpeg` or `ffprobe` is missing.
  - Generate a tiny deterministic audio/video fixture with ffmpeg.
  - Run:
    ```bash
    python3 .agents/skills/av-dialogue-insight/scripts/split_media.py input.mp4 chunks --seconds 2
    ```
  - Assert `chunks/chunks.json` exists.
  - Assert every chunk entry contains:
    ```json
    {
      "path": "chunk0.mp4",
      "offset_seconds": 0,
      "duration_seconds": 2,
      "size_bytes": 1234
    }
    ```

- [x] **Step 2: Implement script**
  - Use `ffprobe` for duration.
  - Try stream copy first:
    ```bash
    ffmpeg -y -ss <offset> -t <seconds> -i <input> -c copy <chunk>
    ```
  - If stream copy fails, retry with conservative re-encode settings:
    ```bash
    ffmpeg -y -ss <offset> -t <seconds> -i <input> -vf scale='min(1280,iw)':-2 -c:v libx264 -preset veryfast -crf 28 -c:a aac -b:a 96k <chunk>
    ```
  - Write relative chunk paths in `chunks.json` so the manifest is portable.

- [x] **Step 3: Verify**
  - Run: `npm run test:run -- tests/integration/av-dialogue-scripts.test.ts`
  - Expected: script tests pass or ffmpeg/ffprobe-specific test skips cleanly.

### Task 5: Add Manifest-Aware Chunk Merging With Deterministic Semantics

**Files:**
- Modify: `.agents/skills/av-dialogue-insight/scripts/merge_chunks.py`
- Modify: `fixtures/av-dialogue-insight/*`
- Test: `tests/integration/av-dialogue-scripts.test.ts`

- [x] **Step 1: Write failing tests for manifest input**
  - `merge_chunks.py --manifest chunks.json --analysis-dir analysis out.json` reads offsets from the split manifest.
  - It remains backwards-compatible with existing `offset:path` positional entries.

- [x] **Step 2: Write failing tests for dedupe semantics**
  - Default event dedupe window is `2.0` seconds.
  - Config flag is:
    ```bash
    --dedupe-window-seconds 2.0
    ```
  - Dedupe key is normalized lowercase `title` plus time window.
  - Tie-breaking keeps the event with the longer `detail`; if equal, keeps the earlier chunk.

- [x] **Step 3: Write failing tests for speaker weighting**
  - If a speaker has `talk_seconds`, recompute final `talk_ratio` as:
    ```text
    sum(speaker.talk_seconds) / total_duration_seconds
    ```
  - If only `talk_ratio` and chunk duration exist, convert to estimated seconds:
    ```text
    speaker.talk_ratio * chunk.duration_seconds
    ```
  - If neither duration nor talk fields are available, preserve the first speaker profile and omit recomputed ratio.

- [x] **Step 4: Implement merge improvements**
  - Add manifest parsing.
  - Add deterministic dedupe.
  - Add speaker weighting while preserving old behavior for sparse model output.
  - Label summary sections as `Chunk <n> (<offset>)` instead of blindly concatenating paragraphs.

- [x] **Step 5: Verify**
  - Run: `npm run test:run -- tests/integration/av-dialogue-scripts.test.ts`
  - Expected: merge tests pass.

### Task 6: Validate Analysis JSON Before Rendering

**Files:**
- Create: `.agents/skills/av-dialogue-insight/scripts/validate_analysis.py`
- Modify: `.agents/skills/av-dialogue-insight/scripts/render_report.py`
- Test: `tests/integration/av-dialogue-scripts.test.ts`

- [x] **Step 1: Write failing validator tests**
  - Valid fixture passes validation.
  - Non-object JSON fails validation.
  - `duration_seconds` must be numeric and non-negative when present.
  - `events`, `speakers`, `emotion_timeline`, and `key_triggers` must be lists when present.
  - Every item in those lists must be an object.
  - Event and trigger `time` values must be strings or numbers parseable by the existing time parser.
  - `talk_ratio` must be numeric and in `[0, 1]` when present.
  - `valence` must be numeric and in `[-1, 1]` when present.
  - Missing optional lists are normalized to empty lists when `--normalize <out.json>` is passed.

- [x] **Step 2: Implement validator**
  - Validate top-level object.
  - Validate renderer-sensitive numeric fields before `render_report.py` can cast them with `float(...)`.
  - Add `--normalize <out.json>` mode to write a normalized copy with safe defaults:
    ```json
    {
      "events": [],
      "speakers": [],
      "emotion_timeline": [],
      "key_triggers": []
    }
    ```

- [x] **Step 3: Keep renderer strict enough**
  - `render_report.py` should continue to reject non-object JSON.
  - Do not make renderer silently repair bad analysis; use the validator for repair.

- [x] **Step 4: Verify**
  - Run: `npm run test:run -- tests/integration/av-dialogue-scripts.test.ts`
  - Expected: validation and render tests pass.

### Task 7: Add Explicitly Opt-In DashScope Smoke Tests

**Files:**
- Create: `tests/integration/dashscope-omni-smoke.test.ts`
- Modify: `vitest.config.ts` only if needed for timeout.

- [x] **Step 1: Write skipped-by-default smoke tests**
  - Skip unless all are true:
    - `RUN_DASHSCOPE_OMNI_SMOKE=1`
    - `DASHSCOPE_API_KEY` or `MINI_AGENT_MM_API_KEY` is set
  - Use model from `MINI_AGENT_MM_MODEL`, defaulting to `qwen3.5-omni-plus`.
  - Use base URL from `MINI_AGENT_MM_BASE_URL`, defaulting to `https://dashscope.aliyuncs.com/compatible-mode/v1`.

- [x] **Step 2: Cover local and URL paths without making CI flaky**
  - Local smoke: tiny generated image or audio file, expected non-empty text.
  - URL smoke: public image URL or audio URL from provider docs, expected non-empty text.
  - Keep both tests skipped unless explicit opt-in is set.

- [x] **Step 3: Verify**
  - Run without opt-in:
    ```bash
    npm run test:run -- tests/integration/dashscope-omni-smoke.test.ts
    ```
  - Expected: all smoke tests skip.
  - Do not add this test to any path that can perform network calls without explicit opt-in.

### Task 8: Update Runtime Docs After Hardware Lands

**Files:**
- Modify: `README.md`
- Modify: `docs/specs/av-dialogue-insight-spec.md`
- Test: `npm run check`

- [x] **Step 1: Document actual supported transports**
  - Local inline Base64 for small files.
  - URL transport for user-provided public URLs.
  - Split/compress path for oversized local media.
  - State that the repo does not upload files to OSS automatically.

- [x] **Step 2: Document timeout config**
  - Add `MINI_AGENT_MM_TIMEOUT_MS`.
  - Explain why long media should not use the generic 60s tool timeout.

- [x] **Step 3: Document structured output strategy**
  - Qwen-Omni multimodal calls use prompt-plus-parse-plus-validate.
  - Do not document `response_format` unless an explicit live smoke proves it works for this model path.

- [x] **Step 4: Verify**
  - Run: `npm run check`
  - Expected: typecheck and all tests pass.

## Phase 2: Software - Skill Cleanup After Hardware Exists

### Task 9: Strengthen Skill Readiness Tests Before Rewriting Skills

**Files:**
- Modify: `tests/integration/av-dialogue-readiness.test.ts`
- Modify: `tests/integration/intel-bulletin-readiness.test.ts`
- Test: `tests/integration/av-dialogue-readiness.test.ts`
- Test: `tests/integration/intel-bulletin-readiness.test.ts`

- [x] **Step 1: Add av-dialogue skill text assertions**
  - Activated skill body references `split_media.py`.
  - Activated skill body references `validate_analysis.py`.
  - Activated skill body references `probe_media` recommendation fields.
  - Activated skill body does not present `≤360s` as a hard rule.
  - Activated skill body does not mention URL support before tool URL support exists.

- [x] **Step 2: Add intel-bulletin skill text assertions**
  - Skill body or writing guide says not to invent classification, document number, issuer, or date.
  - Skill body or writing guide says uncertain information must be omitted or marked unknown/pending verification.
  - Skill body keeps style details in the reference file rather than bloating `SKILL.md`.

- [x] **Step 3: Verify**
  - Run:
    ```bash
    npm run test:run -- tests/integration/av-dialogue-readiness.test.ts tests/integration/intel-bulletin-readiness.test.ts
    ```
  - Expected: tests fail before skill cleanup and pass after Tasks 10-11.

### Task 10: Rewrite `av-dialogue-insight` Around Supported Capabilities

**Files:**
- Modify: `.agents/skills/av-dialogue-insight/SKILL.md`
- Modify: `.agents/skills/av-dialogue-insight/references/analysis-schema.md`
- Test: `tests/integration/av-dialogue-readiness.test.ts`

- [x] **Step 1: Update frontmatter description**
  - Include Chinese trigger phrases and contexts:
    - meeting recordings
    - interviews
    - calls
    - surveillance or captured conversation video
    - emotion timeline
    - key trigger points
  - Avoid triggering on generic image/video tasks that do not involve dialogue or conversation analysis.

- [x] **Step 2: Remove capability mismatch**
  - Mention URL only because `analyze_media` now supports URL.
  - State that URL input must include `kind`, and audio URL must include `format`.
  - Replace ad hoc ffmpeg command text with `split_media.py`.

- [x] **Step 3: Add validation step**
  - Insert `validate_analysis.py` before merge/render.
  - State that invalid JSON should trigger one retry, then degraded output.

- [x] **Step 4: Reduce hard-coded thresholds**
  - Replace fixed `≤360s` guidance with `probe_media` recommendation fields.
  - Keep example chunk sizes as examples, not rules.

- [x] **Step 5: Verify**
  - Run: `npm run test:run -- tests/integration/av-dialogue-readiness.test.ts`
  - Expected: readiness and text assertions pass.

### Task 11: Tighten `intel-bulletin` Skill And Template

**Files:**
- Modify: `.agents/skills/intel-bulletin/SKILL.md`
- Modify: `.agents/skills/intel-bulletin/references/writing-guide.md`
- Modify: `.agents/skills/intel-bulletin/assets/spec-template.json`
- Test: `tests/integration/intel-bulletin-readiness.test.ts`

- [x] **Step 1: Improve trigger description**
  - Cover drafting/generating/organizing intelligence bulletins, situation bulletins, public-document-style reports, task CRUD, source ingestion, and rendering.
  - Do not make generic source extraction an unconditional trigger unless the output is a bulletin/report task.

- [x] **Step 2: Add anti-fabrication instruction**
  - Do not invent classification, document number, recipient, issuer, or date.
  - Use only user-provided or source-supported values.
  - If a field is unknown, omit it or mark it as unknown/pending verification according to the user's output requirement.

- [x] **Step 3: Update spec template**
  - Make optional metadata visibly nullable or absent.
  - Add a short `_notes` or comment-equivalent field only if the renderer ignores it; otherwise keep the anti-fabrication guidance in the reference and tests.

- [x] **Step 4: Keep body short**
  - Keep `SKILL.md` under 100 lines.
  - Leave style details in `references/writing-guide.md`.

- [x] **Step 5: Verify**
  - Run: `npm run test:run -- tests/integration/intel-bulletin-readiness.test.ts`
  - Expected: readiness and text assertions pass.

### Task 12: Add Lightweight Skill Quality Evals With Schema Validation

**Files:**
- Create: `.agents/skills/av-dialogue-insight/evals/evals.json`
- Create: `.agents/skills/intel-bulletin/evals/evals.json`
- Create: `tests/integration/skill-evals.test.ts`

- [x] **Step 1: Add practical eval prompts**
  - `av-dialogue-insight` positive prompts:
    - short meeting recording report
    - oversized media planning
    - missing multimodal config
  - `av-dialogue-insight` negative prompt:
    - generic image captioning without dialogue should not force this skill.
  - `intel-bulletin` positive prompts:
    - source docs to bulletin
    - task CRUD
    - uncertain facts in source docs
  - `intel-bulletin` negative prompt:
    - plain extraction only, no bulletin/report output requested.

- [x] **Step 2: Define minimal eval schema**
  - Each eval item must include:
    ```json
    {
      "id": "string",
      "prompt": "string",
      "expected_output": "string",
      "files": []
    }
    ```
  - `files` must be an array.
  - IDs must be unique per skill.

- [x] **Step 3: Write schema-validation test**
  - `tests/integration/skill-evals.test.ts` parses both files.
  - It validates required fields and unique IDs.
  - It asserts each skill has at least one positive and one negative eval by checking a `kind: "positive" | "negative"` field.

- [x] **Step 4: Verify**
  - Run: `npm run test:run -- tests/integration/skill-evals.test.ts`
  - Expected: eval schema test passes.

## Execution Order

1. Task 1 - precise media source/provider contract and strict schema behavior.
2. Task 2 - multimodal timeout.
3. Task 3 - actionable probe planning fields using shared media-limit helpers.
4. Task 4 - deterministic split script.
5. Task 5 - manifest-aware deterministic merge semantics.
6. Task 6 - analysis validation and render hardening.
7. Task 7 - explicitly opt-in DashScope smoke tests.
8. Task 8 - docs for hardware behavior.
9. Task 9 - strengthen readiness/text tests before skill rewrite.
10. Task 10 - av-dialogue skill cleanup.
11. Task 11 - intel-bulletin skill/template cleanup.
12. Task 12 - skill eval files plus schema validation.

Do not start Phase 2 until Tasks 1-8 are complete. The skill text should describe actual tool behavior, not aspirational behavior.

## Self-Review

- The plan separates hardware and software work.
- URL transport is now an explicit provider contract, not a placeholder.
- Strict OpenAI tool-schema null behavior is covered in Task 1.
- Live DashScope tests require explicit opt-in and cannot run merely because a key exists.
- Merge and validation semantics are deterministic enough to test.
- Skill cleanup is delayed until the underlying tools exist and readiness tests can catch stale text.
- The runtime remains text-only; the plan does not add multimodal payloads to `RuntimeMessage` or the main `ModelAdapter` history.
