# Dedicated Audio Path (Doubao ASR) + Tool Write-To-File Implementation Plan

> **For agentic workers:** Implement task-by-task, TDD. Steps use checkbox (`- [ ]`) syntax.
> Run `npm run check` (typecheck + tests) at the end of each phase.

**Goal:** Give pure-audio understanding its own dedicated path using the 火山引擎/豆包 录音文件识别 model (`volc.seedasr.auc`), separate from the Qwen-Omni video path. Along the way, make BOTH media tools (`analyze_media`, `analyze_audio`) **write their full result to a file the Agent chose** and return only a summary + path, instead of inlining large results into the conversation context.

**Scope for this pass:**
- Input is a **public audio URL + format**. Local-file audio is a **TODO** (future `publish_media` helper) — leave a clear seam, do not implement upload.
- Video/image stays on `callOmni` (Qwen-Omni). Audio gets `callAsr` (Doubao).

**Architecture invariants (do not break):**
- Runtime stays text-only: no media bytes in `RuntimeMessage`/`ModelAdapter` history.
- Provider quirks (auth headers, async submit→poll, field shapes) stay inside `src/model/*`; tools/skills see normalized results only.
- Tools persist results to disk; the Agent reads files on demand and only re-persists derived analysis when the user asks.

**Key facts confirmed from the codebase (cite when implementing):**
- The loop serializes the WHOLE tool result `{ok,content,meta,error,artifacts}` via `formatToolMessageContent` into the `role:"tool"` message (`src/runtime/loop.ts:62`, `:207`). So `meta` is **not** a side channel — it enters context. This is why large output must go to a file, not `meta`.
- Tool file writes go through `ctx.policy.resolveWritePath(p)` then `atomicWriteFile` (see `src/tools/write.ts`). `readOnly` mode makes `resolveWritePath` throw `PATH_NOT_ALLOWED` (`src/runtime/policy.ts:84`).
- `ToolArtifact` + `RunManager.recordArtifact` already exist (`src/runtime/run-manager.ts:256`) but no tool except `write` emits artifacts yet. Media tools should.
- Per-tool timeout selection is currently a hardcoded special-case for `analyze_media` (`src/tools/index.ts:108`). Generalize it.
- Multimodal config is wired in `src/cli/main.ts` `toolConfig.multimodal` and surfaced in `src/cli/doctor.ts` `[multimodal_path]`. Mirror this for ASR.

---

## Phase 0: Shared write-to-file behavior + retrofit `analyze_media`

Do this first: it establishes the pattern both tools use and converts the existing tool.

### Task 0.1: Add a shared result-persistence helper

**Files:**
- Create: `src/tools/utils/persist-result.ts`
- Test: `tests/unit/persist-result.test.ts`

- [ ] **Step 1: Failing tests**
  - `persistToolResult({ ctx, outPath, data })` resolves `outPath` via `ctx.policy.resolveWritePath`, writes pretty JSON via `atomicWriteFile`, returns `{ absPath, bytesWritten }`.
  - Creates parent dirs (`mkdir recursive`) so the Agent doesn't have to pre-create them.
  - Uses `ctx.fileMutationQueue.runExclusive` when present; falls back to a direct atomic write when absent (unit-test contexts have no queue).
  - In `readOnly` mode (policy throws), it surfaces a `RuntimeError` with code `PATH_NOT_ALLOWED` and a message telling the caller the path is not writable.
- [ ] **Step 2: Implement** the helper accordingly. Keep it generic (`data: unknown`), JSON-stringify with 2-space indent + trailing newline for deterministic diffs.
- [ ] **Step 3: Verify** `npm run test:run -- tests/unit/persist-result.test.ts`.

### Task 0.2: Retrofit `analyze_media` to write-to-file

**Files:**
- Modify: `src/tools/analyze-media.ts`
- Test: `tests/unit/analyze-media.test.ts`

- [ ] **Step 1: Update tests (behavior change)**
  - `createContext` gains an optional `fileMutationQueue` (import `FileMutationQueue`); add one so the queue path is exercised.
  - Add required `out_path` to every successful call's args (e.g. `"analysis/clip.json"`).
  - Assert the tool **writes a JSON envelope file** at the resolved path containing `{ source, kind, model, text, json, usage }`.
  - Assert `result.content` is now a **short human summary** that includes the written path (e.g. matches `/wrote .*clip\.json/u`), NOT the raw model text.
  - Assert `result.meta` no longer contains `json`; it holds only `{ source, kind, model, outPath, usage }` (small stats).
  - Assert `result.artifacts` includes `{ type: "file", path: out_path }`.
  - Keep all existing source-validation / strict-null / not-configured tests; only the success-shape assertions change.
- [ ] **Step 2: Implement**
  - Add `out_path: z.string().min(1)` (required) to `analyzeMediaArgsSchema`.
  - After `callOmni`, build envelope `{ source, kind, model, text, json, usage }` and `persistToolResult`.
  - Return `content`: `Analyzed <kind> with <model>; wrote result to <absPath> (<bytes> bytes).` + a 1-line hint to read the file for full output.
  - `meta`: `{ source, kind, model, outPath: absPath, usage }`.
  - `artifacts: [{ type: "file", path: out_path, description: "analyze_media result" }]`.
  - On `readOnly`/write failure: return `ok:false` with the persistence error (do not lose the model output — include a truncated preview in `content`).
- [ ] **Step 3: Update the tool description + arg descriptions** (LLM-facing):
  - Description states: "Writes the full result (model text + parsed JSON) to `out_path` and returns a short summary; read `out_path` for the complete output."
  - `out_path` description: "Workspace-relative path where the full result JSON is written. You choose it (e.g. `av-tasks/<id>/analysis/clip.json`)."
  - `want_json` description: clarify the parsed JSON is written into the result file, not returned inline.
- [ ] **Step 4: Verify** `npm run test:run -- tests/unit/analyze-media.test.ts tests/unit/tool-registry.test.ts`.

---

## Phase 1: ASR connection config + diagnostics

### Task 1.1: Add `asr*` runtime config

**Files:**
- Modify: `src/runtime/config.ts`
- Modify: `src/tools/types.ts`
- Test: `tests/unit/config.test.ts`

- [ ] **Step 1: Failing tests**
  - `MINI_AGENT_ASR_*` env vars resolve into config: `asrAppId`, `asrApiKey`, `asrAccessKey`, `asrAppKey`, `asrResourceId`, `asrBaseURL`, `asrTimeoutMs`.
  - `asrResourceId` defaults to `volc.seedasr.auc` when an ASR connection is otherwise configured; `asrBaseURL` defaults to `https://openspeech.bytedance.com`.
  - `asrTimeoutMs` parses as a positive integer only (reuse `parsePositiveInteger`); `0`/negative/non-int ignored.
- [ ] **Step 2: Implement**
  - Add the `asr*` fields to `RuntimeConfig` with a comment block (mirror the multimodal block: kept separate from text + mm connections).
  - Read `MINI_AGENT_ASR_APP_ID / _API_KEY / _ACCESS_KEY / _APP_KEY / _RESOURCE_ID / _BASE_URL / _TIMEOUT_MS` in `readEnvConfig`.
  - Add `AsrToolConfig` to `src/tools/types.ts` (`{ baseURL, resourceId, appId?, apiKey?, accessKey?, appKey?, timeoutMs? }`) and an optional `asr?: AsrToolConfig` on `ToolRuntimeConfig`. Auth supports BOTH new console (`apiKey`→`X-Api-Key`) and old console (`appKey`+`accessKey`→`X-Api-App-Key`+`X-Api-Access-Key`).
- [ ] **Step 3: Verify** `npm run test:run -- tests/unit/config.test.ts`.

### Task 1.2: Wire ASR into the agent + doctor

**Files:**
- Modify: `src/cli/main.ts`
- Modify: `src/cli/doctor.ts`
- Test: `tests/unit/cli-doctor.test.ts`

- [ ] **Step 1: Failing tests** — `doctor` prints an `[asr_path]` block: `asr_configured`, `asr_resource_id`, `asr_base_url`, `asr_auth` (`api-key` | `app-key+access-key` | `missing`), `asr_timeout_ms`.
- [ ] **Step 2: Implement**
  - In `main.ts`, build `toolConfig.asr` when ASR creds exist (an ASR connection is "configured" when `asrApiKey` OR (`asrAppKey` && `asrAccessKey`) is present). Do NOT fall back to the primary/mm connection — Doubao auth is not OpenAI-compatible.
  - Add `asrPath` to `DoctorReportInput` and render `[asr_path]`. Update the doctor call site that assembles `DoctorReportInput`.
- [ ] **Step 3: Verify** `npm run test:run -- tests/unit/cli-doctor.test.ts`.

---

## Phase 2: ASR client (`src/model/asr.ts`)

### Task 2.1: Implement `callAsr` (submit → poll → normalize)

**Files:**
- Create: `src/model/asr.ts`
- Test: `tests/unit/asr.test.ts`

- [ ] **Step 1: Failing tests** (inject a fake `fetch`):
  - **Submit:** POSTs to `<baseURL>/api/v3/auc/bigmodel/submit` with headers — new console: `X-Api-Key`, `X-Api-Resource-Id`, `X-Api-Request-Id` (a generated UUID), `X-Api-Sequence: -1`; old console: `X-Api-App-Key` + `X-Api-Access-Key` instead of `X-Api-Key`. Body `{ user, audio:{url,format,...}, request:{ model_name:"bigmodel", ... } }`.
  - Request body reflects params: `enable_speaker_info`, `enable_emotion_detection`, `show_utterances:true`, `enable_punc:true`, `enable_itn:true`, `language?`, `context.hotwords` from `hotwords`, and any `advanced` JSON merged into `request`.
  - **Poll:** POSTs to `/query` with `X-Api-Request-Id` reused; reads status from the **`X-Api-Status-Code` response header**. `20000001`(processing)/`20000002`(queued) → keep polling; `20000000` → parse body. Backoff sequence honored and `signal` aborts the loop.
  - **Normalize:** maps `result.text` → `text`; `result.utterances[]` → `AsrUtterance[]` (`startMs`,`endMs`,`text`, plus best-effort `speaker`/`emotion`/`speechRate`/`volume`/`gender` from utterance `additions`). Keeps `raw` = parsed body, `durationMs` from `audio_info.duration`.
  - **Errors → RuntimeError:** `20000003`(silent)→ ok result flagged silent (empty utterances, `degradedNote`), not throw; `45000001/2/151`→`INVALID_ARGS` non-retriable; `45000131`/`55000031`→ retriable; `45000132`→`INVALID_ARGS` with size guidance; network/timeout→`MODEL_ERROR` retriable. Wrap with a `category: "asr"` detail.
- [ ] **Step 2: Implement** with native `fetch`/undici (NOT the OpenAI SDK). Export `callAsr(params)` and the `AsrResult`/`AsrUtterance` types. Poll backoff e.g. `[2000,3000,5000,10000…cap]`, overall bounded by `timeoutMs`. UUID via `crypto.randomUUID()`.
  - ⚠️ **Field-name caveat:** the doc's response sample omits `additions`. Mark the `additions` field mapping with a `// VERIFY against real Doubao output` comment; keep normalization defensive (optional chaining, skip unknown fields) so missing fields never throw.
- [ ] **Step 3: Verify** `npm run test:run -- tests/unit/asr.test.ts`.

---

## Phase 3: `analyze_audio` tool

### Task 3.1: Implement the tool + generalize per-tool timeout

**Files:**
- Create: `src/tools/analyze-audio.ts`
- Modify: `src/tools/index.ts` (register + generalize timeout)
- Test: `tests/unit/analyze-audio.test.ts`
- Test: `tests/unit/tool-registry.test.ts`

- [ ] **Step 1: Failing tests**
  - Schema (`.strict()`): `url` (required, `.url()`), `format` (required), `out_path` (required), `language?`, `speaker?` (default true), `emotion?` (default true), `hotwords?: string[]`, `advanced?: string` (raw JSON string). Reject missing `url`/`format`/`out_path`; reject non-JSON `advanced`.
  - Not-configured guard: returns `MODEL_ERROR` with a message naming `MINI_AGENT_ASR_*` when `ctx.config.asr` is absent.
  - Delegates to a mocked `callAsr`, then **writes the envelope** (`{ provider, resourceId, language, text, durationMs, utterances, raw, degradedNote? }`) to `out_path`; `content` is a summary (utterance count, duration, speaker count, path); `meta` is small stats `{ outPath, durationMs, utteranceCount, speakerCount }`; `artifacts` includes the file.
  - `ToolRegistry` selects `asrTimeoutMs` for `analyze_audio` and `mmTimeoutMs` for `analyze_media` (generalized map, not an `if` chain).
- [ ] **Step 2: Implement**
  - Default-on params passed to `callAsr`; `advanced` parsed with a clear `INVALID_ARGS` on failure; persist via `persistToolResult`.
  - In `src/tools/index.ts`, replace the `analyze_media`-only timeout `if` with a lookup: `{ analyze_media: cfg.mmTimeoutMs, analyze_audio: cfg.asrTimeoutMs }[tool.name] ?? cfg.toolTimeoutMs`. Register `analyzeAudioTool` in `createDefaultToolRegistry`.
- [ ] **Step 3: Tool description (LLM-facing) — make the contract explicit:**
  - "Transcribe & analyze a **public audio URL** with the Doubao recording model: word/utterance timestamps, speaker separation, per-utterance emotion, speech-rate, volume, gender. **Writes the full result JSON to `out_path`; read that file for transcript + utterances.** Use for meeting/interview/call audio. For video, use `analyze_media` instead. Transcripts may contain recognition errors — re-read the audio context and correct them when analyzing."
  - Per-arg descriptions for `format` (wav/mp3/ogg/pcm…), `out_path`, `hotwords` (domain terms to bias recognition), `advanced` (escape hatch: raw JSON merged into the provider `request`).
- [ ] **Step 4: Verify** `npm run test:run -- tests/unit/analyze-audio.test.ts tests/unit/tool-registry.test.ts`.

---

## Phase 4: Deterministic audio stats helper

### Task 4.1: `audio_stats.py`

**Files:**
- Create: `.agents/skills/av-dialogue-insight/scripts/audio_stats.py`
- Test: `tests/integration/av-dialogue-scripts.test.ts`

- [ ] **Step 1: Failing test** — feed a small normalized asr.json fixture (the envelope written by `analyze_audio`); assert output JSON has: per-speaker `talk_seconds` (Σ `endMs-startMs`/1000) and `talk_ratio` (/ total speech seconds), an `emotion_histogram`, and `utterances_abs` (relative→absolute time when an `--offset-seconds` is given). Deterministic ordering.
- [ ] **Step 2: Implement** consuming the **normalized** envelope (not raw Doubao), so a provider swap doesn't break it. Pure stdlib.
- [ ] **Step 3: Verify** `npm run test:run -- tests/integration/av-dialogue-scripts.test.ts`.

---

## Phase 5: Skill, schema, and docs

### Task 5.1: Rewrite the audio path in the skill

**Files:**
- Modify: `.agents/skills/av-dialogue-insight/SKILL.md`
- Modify: `.agents/skills/av-dialogue-insight/references/analysis-schema.md`
- Test: `tests/integration/av-dialogue-readiness.test.ts`

- [ ] **Step 1: Readiness-test assertions (write first)**
  - Activated body references `analyze_audio` and says audio uses it (not `analyze_media`); video uses `analyze_media`.
  - Body states both media tools **write to a file you name (`out_path`) and you read it back** — large results are not returned inline.
  - Body references `audio_stats.py` for reproducible talk-ratio/emotion counts.
  - Body says transcripts may contain errors and the model should correct them using context.
  - Body keeps the local-audio path as an explicit TODO (URL-only for now).
- [ ] **Step 2: Rewrite SKILL.md workflow**
  - Routing: audio → `analyze_audio(url, format, out_path)`; video → `probe_media` then `analyze_media(..., out_path)`.
  - Read the written file; optionally run `audio_stats.py`; the model does correction + events/triggers/summary/profile in-loop; persist `analysis.json` only if the user wants a saved report, then `validate_analysis.py` → `render_report.py`.
  - Keep under ~100 lines; push schema detail to the reference.
- [ ] **Step 3: Update analysis-schema.md**
  - Add `transcript`, `utterances`, and `method` (`"doubao-asr"|"omni"|"classic-pipeline"`) fields.
  - Add the emotion→valence mapping table used when turning Doubao emotion labels into `emotion_timeline.valence` (e.g. angry −0.6 / sad −0.5 / neutral 0 / surprise +0.1 / happy +0.6) and note `surprise` is ambiguous.
- [ ] **Step 4: Verify** `npm run test:run -- tests/integration/av-dialogue-readiness.test.ts`.

### Task 5.2: Runtime docs

**Files:**
- Modify: `README.md`
- Modify: `docs/specs/av-dialogue-insight-spec.md`

- [ ] **Step 1:** Document the audio path: Doubao recording model, `MINI_AGENT_ASR_*` env, URL-only (local = TODO), async submit→poll with `asrTimeoutMs`, write-to-file tool contract for both media tools, and that ASR auth is separate from the text/mm connections.
- [ ] **Step 2:** Update the spec §2 tool table to add `analyze_audio` and note the write-to-file change for `analyze_media`.
- [ ] **Step 3: Verify** `npm run check`.

---

## Phase 6 (optional, rubric): 3-way comparison experiment

Use the existing `experiments/` harness + `fallback_pipeline.py` baseline. Compare pure-audio: (1) Qwen-Omni on audio, (2) Doubao ASR pipeline, (3) classic Whisper+pyannote — on WER, timestamp/speaker accuracy, emotion agreement, latency, cost. Gated behind explicit opt-in like the DashScope smoke test. Mark optional; do after Phases 0–5 land.

---

## Execution order
0. Phase 0 (shared persistence + analyze_media retrofit)
1. Phase 1 (config + doctor)
2. Phase 2 (asr.ts client)
3. Phase 3 (analyze_audio tool + timeout generalization)
4. Phase 4 (audio_stats.py)
5. Phase 5 (skill/schema/docs)
6. Phase 6 (optional experiment)

## Open items / caveats carried in
- **Local audio file → URL** is a TODO (`publish_media`). Tool only accepts `url`+`format` now.
- **Doubao `additions` field names** (speaker/emotion/rate/volume/gender) must be verified against a real API response before trusting the normalized fields; keep mapping defensive.
- `out_path` is **required** on both media tools; in `readOnly` mode the write fails by design — surface a clear error rather than silently inlining.

## Self-review
- Runtime stays text-only; provider quirks isolated in `src/model/asr.ts`.
- Both media tools share one persistence helper and one write-to-file contract; descriptions updated so the LLM knows to read the file.
- Per-tool timeout generalized rather than special-cased.
- ASR auth kept separate from text/mm connections (not OpenAI-compatible).
- Deterministic numbers (talk ratio, emotion counts) come from a helper, satisfying the report's reproducible-comparison need; the LLM still owns understanding + transcript correction.
