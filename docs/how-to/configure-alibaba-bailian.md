# Configure Alibaba Cloud Bailian / DashScope

Use this guide when you want to run `mini-agent` through Alibaba Cloud Model
Studio, also known as Bailian or DashScope. Bailian uses the existing
`openai-compatible` provider in mini-agent.

This guide covers:

- the primary text model for the agent loop
- optional Qwen-Omni configuration for `analyze_media`
- verification with `doctor` and an optional live smoke test

## 1. Choose The Region Endpoint

Choose the endpoint for the same region where your API key and model workspace
live. In mini-agent, set the base URL without `/chat/completions`.

| Region | `MINI_AGENT_BASE_URL` / `MINI_AGENT_MM_BASE_URL` |
| --- | --- |
| China (Beijing) | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Singapore | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| US (Virginia) | `https://dashscope-us.aliyuncs.com/compatible-mode/v1` |
| China (Hong Kong) | `https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1` |
| Germany (Frankfurt) | `https://<WorkspaceId>.eu-central-1.maas.aliyuncs.com/compatible-mode/v1` |

For Germany, replace `<WorkspaceId>` with the actual workspace ID from the
Bailian console.

## 2. Create An API Key

In the Alibaba Cloud Model Studio console:

1. Select the same region you chose above.
2. Open the API Key page.
3. Create an API key for the target workspace.
4. Copy the key and keep it out of chat, logs, and committed files.

For team or production usage, prefer a workspace with only the models you need.
If the console offers custom permissions or an IP allowlist for your region, use
them.

## 3. Configure The Primary Agent Model

Pick a model name that is available in your chosen region, for example
`qwen-plus`, `qwen3.5-plus`, or another exact name from the Model Studio model
list.

```bash
export MINI_AGENT_PROVIDER=openai-compatible
export MINI_AGENT_MODEL=qwen-plus
export MINI_AGENT_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
export MINI_AGENT_API_KEY=your-bailian-api-key
```

Then verify:

```bash
npm run dev -- doctor
```

Check `[model_provider]`:

- `provider` is `openai-compatible`
- `model` is the model you selected
- `base_url` is the Bailian endpoint for your region
- `api_key` is `configured`

Run a minimal prompt:

```bash
npm run dev -- "用一句话说明你是谁"
```

## 4. Optional: Configure Qwen-Omni For Video/Image

Use this when you want the `analyze_media` tool for image or video
understanding. If the primary model connection already points to Bailian and the
same key can call Qwen-Omni, only set the multimodal model:

```bash
export MINI_AGENT_MM_MODEL=qwen3.5-omni-plus
```

If the multimodal model uses a different region, workspace, or API key, set
explicit multimodal overrides:

```bash
export MINI_AGENT_MM_MODEL=qwen3.5-omni-plus
export MINI_AGENT_MM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
export MINI_AGENT_MM_API_KEY=your-bailian-api-key
export MINI_AGENT_MM_TIMEOUT_MS=180000
```

Then run:

```bash
npm run dev -- doctor
```

Check `[multimodal_path]` for `mm_configured yes`.

Notes:

- `analyze_media` activates only when `MINI_AGENT_MM_MODEL` is set.
- mini-agent handles Qwen-Omni streaming internally.
- Local DashScope media uses inline Base64 and is limited by the encoded
  payload size; mini-agent currently enforces a 10MB encoded payload limit for
  this path. For larger local video/image, use a reachable URL or configure TOS
  upload.
- mini-agent does not require Alibaba OSS. Any model-reachable media URL works;
  the built-in automatic upload path is Volcano Engine TOS.

## 5. Optional: Run The Live Qwen-Omni Smoke Test

This calls the real DashScope service and may incur provider usage. Run it only
when you intentionally want a live check:

```bash
RUN_DASHSCOPE_OMNI_SMOKE=1 \
DASHSCOPE_API_KEY=your-bailian-api-key \
npm run test:run -- tests/integration/dashscope-omni-smoke.test.ts
```

You can also use `MINI_AGENT_MM_API_KEY`, `MINI_AGENT_MM_MODEL`, and
`MINI_AGENT_MM_BASE_URL` instead of `DASHSCOPE_API_KEY` when you need explicit
mini-agent overrides.

## Common Failures

- `api_key missing` in `[model_provider]`: set `MINI_AGENT_API_KEY`.
- Authentication fails: check that the API key belongs to the same region and
  workspace as the endpoint, and that any IP allowlist includes your machine.
- Model not found or unauthorized: use the exact model name available in the
  selected Model Studio region/workspace.
- Endpoint error: set the base URL ending in `/compatible-mode/v1`, not the full
  `/chat/completions` URL.
- `[multimodal_path] mm_configured no`: set `MINI_AGENT_MM_MODEL`.
- Large local video/image fails on inline size: pass an existing reachable URL
  or configure TOS upload for a short-lived pre-signed URL.

## Official References

- Alibaba Cloud Model Studio API key guide:
  https://www.alibabacloud.com/help/en/model-studio/get-api-key
- OpenAI-compatible Model Studio endpoint guide:
  https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope
- Qwen-Omni guide:
  https://www.alibabacloud.com/help/en/model-studio/qwen-omni
