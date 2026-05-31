---
name: volcengine-media-setup
description: >-
  Guide users through low-friction setup for mini-agent media capabilities on
  Volcano Engine: primary or multimodal model config, Doubao recording ASR /
  语音 API Key, and optional TOS object storage for large local media URLs. Use
  this skill whenever the user mentions 火山引擎, TOS, 对象存储, 语音 API key,
  豆包 ASR, 大文件上传, public media URL, local audio/video setup, or asks how
  to configure media analysis credentials.
compatibility: Works with mini-agent's current config surface for model, multimodal, and ASR settings. TOS setup is optional onboarding guidance unless the current branch has automatic TOS upload support.
allowed-tools: read write edit bash
metadata:
  author: mini-agent
  version: "1.0.0"
---

# Volcano Engine Media Setup

## Goal

Help a user get media analysis working without making TOS a first-run blocker.
Start with the smallest working setup, then add Doubao ASR and TOS only when
the user's task actually needs them.

## Ground Rules

- Do not ask the user to paste secret values into chat unless they explicitly
  choose to. Prefer shell `export` snippets with placeholders.
- Do not print access keys, API keys, or secret keys. If verification needs a
  value, ask only whether it is set, or show the last 4 characters when the user
  explicitly requests it.
- Keep TOS buckets private. Prefer short-lived pre-signed GET URLs instead of
  public-read buckets.
- Treat TOS as optional during first startup. It is only needed for local media
  that must become reachable by a model service, especially large files and
  audio sent to URL-only ASR.

## Fast Triage

Ask at most one clarifying question if the user's goal is unclear:

```text
你现在想先完成哪一步：大模型可用、语音 ASR 可用，还是本地大文件上传到 TOS？
```

If the user already named a goal, proceed directly.

## Setup Phases

### Phase 1: Primary Model First

Use this when the user is starting from zero or says "先把大模型跑起来".

Provide the minimal environment variables:

```bash
export MINI_AGENT_PROVIDER=openai-compatible
export MINI_AGENT_MODEL=your-model-name
export MINI_AGENT_API_KEY=your-api-key
export MINI_AGENT_BASE_URL=https://your-openai-compatible-endpoint/v1
```

Then verify:

```bash
npm run dev -- doctor
```

Tell the user to check `[model_provider]` for `api_key configured`.

### Phase 2: Multimodal Model For Video/Image

Use this when the user wants `analyze_media` for image/video understanding.
This is separate from the primary text model.

```bash
export MINI_AGENT_MM_MODEL=qwen3.5-omni-plus
export MINI_AGENT_MM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
export MINI_AGENT_MM_API_KEY=your-multimodal-api-key
export MINI_AGENT_MM_TIMEOUT_MS=180000
```

Then run:

```bash
npm run dev -- doctor
```

Tell the user to check `[multimodal_path]`.

### Phase 3: Doubao Recording ASR / 语音 API Key

Use this when the user wants transcript, speaker separation, or emotion
analysis from audio.

Preferred API-key mode:

```bash
export MINI_AGENT_ASR_API_KEY=your-doubao-asr-api-key
export MINI_AGENT_ASR_RESOURCE_ID=volc.seedasr.auc
export MINI_AGENT_ASR_BASE_URL=https://openspeech.bytedance.com
export MINI_AGENT_ASR_TIMEOUT_MS=180000
```

Alternative app-key/access-key mode:

```bash
export MINI_AGENT_ASR_APP_KEY=your-doubao-app-key
export MINI_AGENT_ASR_ACCESS_KEY=your-doubao-access-key
export MINI_AGENT_ASR_RESOURCE_ID=volc.seedasr.auc
export MINI_AGENT_ASR_BASE_URL=https://openspeech.bytedance.com
export MINI_AGENT_ASR_TIMEOUT_MS=180000
```

Then run:

```bash
npm run dev -- doctor
```

Tell the user to check `[asr_path]` for `asr_configured yes`.

If ASR is configured but the user only has a local audio file, explain that the
current ASR tool needs a public audio URL. Move to Phase 4.

### Phase 4: Optional TOS For Large Local Media

Use this only when local media must become a URL, or when a large video/image is
over the inline Base64 limit.

Guide the user through Volcano Engine:

1. Open the TOS service guide:
   `https://www.volcengine.com/docs/6349/74830?lang=zh`
2. Enable TOS if it is not already enabled.
3. Create a bucket in the desired region.
4. Keep bucket access private.
5. Record the bucket name, region, and endpoint.
6. Create or choose an access key with least privilege for the target bucket.
   For an upload-and-signed-URL workflow, it usually needs object upload and
   object read/signing permissions for the chosen prefix.
7. Add a lifecycle rule for the upload prefix if the bucket is only used for
   temporary model inputs.

Useful TOS API/function reference:

```text
https://www.volcengine.com/docs/6349/74837?lang=zh
```

For branches that support automatic TOS upload, prepare these values:

```bash
export MINI_AGENT_TOS_ACCESS_KEY_ID=your-tos-ak
export MINI_AGENT_TOS_ACCESS_KEY_SECRET=your-tos-sk
export MINI_AGENT_TOS_BUCKET=your-bucket
export MINI_AGENT_TOS_REGION=cn-beijing
# Optional when the endpoint cannot be inferred or a custom domain is used:
export MINI_AGENT_TOS_ENDPOINT=https://tos-cn-beijing.volces.com
# Optional defaults:
export MINI_AGENT_TOS_PREFIX=mini-agent/uploads
export MINI_AGENT_TOS_SIGNED_URL_EXPIRES=3600
```

If the current branch does not yet support automatic TOS upload, do not pretend
it does. Tell the user to upload the file manually or through their own TOS
tooling, generate a short-lived GET URL, and pass that URL to `analyze_media`
or `analyze_audio`.

## Output Format

When guiding setup, end with this compact status card:

```markdown
**当前状态**
- 大模型: configured/missing/unknown
- 多模态: configured/missing/unknown
- 语音 ASR: configured/missing/unknown
- TOS: optional/configured/missing/unknown

**下一步**
<one concrete command or console action>

**验证**
<doctor command or tool call to run next>
```

## Common Failures

- `api_key missing` in `[model_provider]`: set `MINI_AGENT_API_KEY`.
- `[multimodal_path] mm_configured no`: set `MINI_AGENT_MM_MODEL`.
- `[asr_path] asr_configured no`: set `MINI_AGENT_ASR_API_KEY`, or
  `MINI_AGENT_ASR_APP_KEY` plus `MINI_AGENT_ASR_ACCESS_KEY`.
- Local audio cannot be passed to `analyze_audio`: upload it to TOS or another
  object store and use a public or pre-signed URL.
- Large local video/image exceeds inline limit: compress it, split it, or upload
  it to TOS and use a short-lived URL.
