# CLI And Config Reference

## CLI

### Syntax

```bash
mini-agent [prompt]
```

### Flags

| Flag | Meaning |
| --- | --- |
| `--cwd <path>` | Use a different workspace root. |
| `--provider <name>` | Select the model provider. v1 supports `openai-compatible`. |
| `--model <name>` | Select the model name passed to the provider. |
| `--base-url <url>` | Override the provider base URL. |
| `--api-key <token>` | Override the provider API key. |
| `--session <id>` | Resume an existing session ID if present. |
| `--skill-dir <path>` | Add a skill directory. Repeatable. |
| `--trace compact|verbose|json` | Choose compact timeline, verbose timeline, or raw JSON event output. |
| `--show-plan` | Keep planning/progress summaries visible. |
| `--hide-debug` | Hide debug-only details in verbose output. |
| `--json-events` | Emit runtime events as JSON lines. |
| `--read-only` | Disallow writes through the runtime. |
| `--max-turns <n>` | Set the loop turn cap. |
| `--help` | Show usage. |

### Commands

| Command | Meaning |
| --- | --- |
| `mini-agent skills list` | Print discovered skills. |
| `mini-agent run list` | List stored runs ordered by newest first. |
| `mini-agent run show <id>` | Render one run as a timeline. |
| `mini-agent run show <id> --format timeline|json|jsonl|markdown` | Switch the run output format. |
| `mini-agent run show <id> --verbose` | Show verbose timeline details such as debug events, args previews, stdout/stderr tails, and log paths. |
| `mini-agent run show <id> --recover` | Load the longest valid trace prefix when the trace tail is damaged. |
| `mini-agent session list` | List saved sessions. |
| `mini-agent session show <id>` | Print a session header and entries in strict mode. |
| `mini-agent session show <id> --recover` | Print the longest recoverable prefix and the repair-report path when corruption is found. |
| `mini-agent session show <id> --trace` | Render all known run traces linked to the session. |
| `mini-agent session show <id> --trace --run <run-id>` | Render one specific run linked to the session. |
| `mini-agent doctor` | Print connection and workspace status. |
| `mini-agent doctor --last-run` | Include the latest run diagnostics snapshot. |
| `mini-agent doctor --run <run-id>` | Rebuild diagnostics for a specific run. |

## Environment Variables

Environment variables are grouped by setup path. Most users only need the
primary model variables; media variables are additive.

### Primary Model

| Variable | Required | Meaning |
| --- | --- | --- |
| `MINI_AGENT_PROVIDER` | No | Provider name. Defaults to `openai-compatible`. |
| `MINI_AGENT_MODEL` | Yes | Model used by the agent loop. |
| `MINI_AGENT_API_KEY` | Yes | Provider API key. `OPENAI_API_KEY` is accepted as a fallback. |
| `MINI_AGENT_BASE_URL` | Depends | OpenAI-compatible endpoint. Omit only when using the provider default. |

### Doctor Smoke Path

These values do not change the active runtime connection. They only let
`doctor` display an operator-known-good path for comparison.

| Variable | Meaning |
| --- | --- |
| `MINI_AGENT_SMOKE_PROVIDER` | Smoke-path provider name. |
| `MINI_AGENT_SMOKE_MODEL` | Smoke-path model. |
| `MINI_AGENT_SMOKE_BASE_URL` | Smoke-path base URL. |

### Multimodal Video/Image

`analyze_media` activates only when `MINI_AGENT_MM_MODEL` is set. `MM_BASE_URL`
and `MM_API_KEY` fall back to the primary connection when omitted.

| Variable | Required | Meaning |
| --- | --- | --- |
| `MINI_AGENT_MM_PROVIDER` | No | Multimodal provider. Defaults to `openai-compatible` when `MM_MODEL` is set. |
| `MINI_AGENT_MM_MODEL` | Yes, for `analyze_media` | Multimodal model name. |
| `MINI_AGENT_MM_BASE_URL` | No | Multimodal endpoint override. |
| `MINI_AGENT_MM_API_KEY` | No | Multimodal API key override. |
| `MINI_AGENT_MM_TIMEOUT_MS` | No | Timeout for `analyze_media`; useful for long media. |

### Doubao Audio ASR

`analyze_audio` uses dedicated ASR credentials and never falls back to the text
or multimodal connection. There is no global engine variable: pass
`engine: "standard" | "turbo"` on each tool call.

| Variable | Required | Meaning |
| --- | --- | --- |
| `MINI_AGENT_ASR_API_KEY` | One auth mode | API-key auth. |
| `MINI_AGENT_ASR_APP_KEY` | One auth mode | App-key auth; use with `MINI_AGENT_ASR_ACCESS_KEY`. |
| `MINI_AGENT_ASR_ACCESS_KEY` | One auth mode | Access key for app-key auth. |
| `MINI_AGENT_ASR_APP_ID` | No | Optional app ID. |
| `MINI_AGENT_ASR_RESOURCE_ID` | No | Standard engine resource. Defaults to `volc.seedasr.auc` when ASR auth is configured. |
| `MINI_AGENT_ASR_BASE_URL` | No | Defaults to `https://openspeech.bytedance.com` when ASR auth is configured. |
| `MINI_AGENT_ASR_TIMEOUT_MS` | No | Timeout for `analyze_audio`. |
| `MINI_AGENT_ASR_TURBO_RESOURCE_ID` | No | Turbo engine resource. Defaults to `volc.bigasr.auc_turbo`. |
| `MINI_AGENT_ASR_TURBO_MAX_BYTES` | No | Max raw bytes for local turbo inline audio. Defaults to `20000000`; hard-capped at `100000000`. |

Legacy `asrEngine` in `mini-agent.config.json` and `MINI_AGENT_ASR_ENGINE` are
not used. Engine choice belongs to each `analyze_audio` call so the agent can
match the request, file, and desired output.

### Optional TOS Upload

TOS is only needed when local media must become a model-reachable URL, such as
large local video/image or standard-engine local audio.

| Variable | Required | Meaning |
| --- | --- | --- |
| `MINI_AGENT_TOS_ACCESS_KEY_ID` | Yes, for TOS | Volcano Engine TOS access key ID. |
| `MINI_AGENT_TOS_ACCESS_KEY_SECRET` | Yes, for TOS | TOS access key secret. |
| `MINI_AGENT_TOS_BUCKET` | Yes, for TOS | Private bucket for temporary media objects. |
| `MINI_AGENT_TOS_REGION` | Yes, for TOS | Bucket region, for example `cn-beijing`. |
| `MINI_AGENT_TOS_ENDPOINT` | No | Endpoint override. Native `tos-<region>...` and S3 `tos-s3-<region>...` hosts are both accepted; uploads use the S3-protocol host. |
| `MINI_AGENT_TOS_PREFIX` | No | Object key prefix. Defaults to `mini-agent/uploads`. |
| `MINI_AGENT_TOS_SIGNED_URL_EXPIRES` | No | Pre-signed URL lifetime in seconds. Defaults to `3600`. |

### Runtime Behavior

| Variable | Meaning |
| --- | --- |
| `MINI_AGENT_SESSION_DIR` | Session directory override. |
| `MINI_AGENT_MAX_TURNS` | Loop turn cap. |
| `MINI_AGENT_TOOL_TIMEOUT_MS` | Generic tool timeout. |
| `MINI_AGENT_BASH_TIMEOUT_MS` | Bash timeout. |
| `MINI_AGENT_MAX_BASH_OUTPUT_BYTES` | Bash output tail size kept in context. |
| `MINI_AGENT_READ_MAX_BYTES` | Byte cap on how much of a file `read` scans; line windowing (`offset`/`limit`) is applied within it. |
| `MINI_AGENT_GLOBAL_SKILL_DIRS` | Comma-separated global skill directories. |
| `MINI_AGENT_ALLOW_READ_OUTSIDE_WORKSPACE` | Allow reads outside the workspace. |
| `MINI_AGENT_ALLOW_WRITE_OUTSIDE_WORKSPACE` | Allow writes outside the workspace. |
| `MINI_AGENT_TRACE_MODE` | Default trace mode: `compact`, `verbose`, or `json`. |
| `MINI_AGENT_SHOW_PLAN` | Show planning/progress summaries. |
| `MINI_AGENT_HIDE_DEBUG` | Hide debug-only details in verbose output. |
| `MINI_AGENT_JSON_EVENTS` | Enable JSON event output; also selects JSON trace mode. |
| `MINI_AGENT_READ_ONLY` | Enable read-only mode. |

## `mini-agent.config.json`

### Supported keys

```json
{
  "provider": "openai-compatible",
  "model": "gpt-4.1",
  "baseURL": "https://your-endpoint.example.com/v1",
  "apiKey": "your-api-key",
  "smokeProvider": "openai-compatible",
  "smokeModel": "gpt-4.1",
  "smokeBaseURL": "https://your-endpoint.example.com/v1",
  "mmProvider": "openai-compatible",
  "mmModel": "qwen3.5-omni-plus",
  "mmBaseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "mmApiKey": "your-multimodal-api-key",
  "asrAppId": "your-asr-app-id",
  "asrApiKey": "your-doubao-asr-api-key",
  "asrAccessKey": "your-doubao-access-key",
  "asrAppKey": "your-doubao-app-key",
  "asrResourceId": "volc.seedasr.auc",
  "asrBaseURL": "https://openspeech.bytedance.com",
  "asrTurboResourceId": "volc.bigasr.auc_turbo",
  "asrTurboMaxBytes": 20000000,
  "workspaceRoot": ".",
  "sessionDir": ".mini-agent/sessions",
  "maxTurns": 12,
  "toolTimeoutMs": 60000,
  "mmTimeoutMs": 180000,
  "asrTimeoutMs": 180000,
  "bashTimeoutMs": 120000,
  "maxBashOutputBytes": 65536,
  "readMaxBytes": 262144,
  "tosAccessKeyId": "your-tos-ak",
  "tosAccessKeySecret": "your-tos-sk",
  "tosBucket": "your-bucket",
  "tosRegion": "cn-beijing",
  "tosEndpoint": "tos-s3-cn-beijing.volces.com",
  "tosPrefix": "mini-agent/uploads",
  "tosSignedUrlExpires": 3600,
  "globalSkillDirs": ["~/.agents/skills"],
  "explicitSkillDirs": [],
  "allowReadOutsideWorkspace": false,
  "allowWriteOutsideWorkspace": false,
  "traceMode": "compact",
  "showPlan": true,
  "hideDebug": false,
  "jsonEventMode": false,
  "readOnly": false
}
```

## Provider Support

### `openai-compatible`

Uses the OpenAI Node SDK against:

- the default OpenAI endpoint when `baseURL` is omitted
- any compatible endpoint when `baseURL` is supplied

For Alibaba Cloud Model Studio / Bailian / DashScope, see
[Configure Alibaba Cloud Bailian / DashScope](../how-to/configure-alibaba-bailian.md).

Required connection inputs:

- `model`
- `apiKey`

Optional connection inputs:

- `baseURL`

Optional smoke-path inputs for operator diagnostics:

- `smokeProvider`
- `smokeModel`
- `smokeBaseURL`

These do not change the runtime’s active provider. They only let `doctor` report the operator’s intended known-good smoke path.

## Optional Volcano Engine TOS Upload

TOS is optional. Add it only when local media must become a model-reachable URL:
large video/image, or standard-engine local audio. Turbo audio can inline
supported local wav/mp3/ogg/opus files without TOS.

Use the Volcano Engine TOS service and API references when creating the bucket,
credentials, and upload permissions:

- https://www.volcengine.com/docs/6349/74830?lang=zh
- https://www.volcengine.com/docs/6349/74837?lang=zh

See [Configure Volcano Engine TOS for local media](../how-to/configure-volcengine-tos.md)
for the full workflow and the exact environment variables.

## `doctor` Output

`mini-agent doctor` prints grouped diagnostics in the following sections:

- `[runtime_basics]`
- `[model_provider]`
- `[skill_discovery]`
- `[session_health]`
- `[smoke_path]`
- `[multimodal_path]`
- `[asr_path]`
- `[tos_storage]`
- `[last_run]` when `--last-run` or `--run <id>` is used

The session-health section is derived from strict and recover loads:

- `valid_sessions`
- `degraded_sessions`
- `corrupted_sessions`

The smoke-path section reports whether a known-good provider/model path has been configured for operator checks.

The TOS section reports whether optional local media upload is configured. It
shows bucket, region, endpoint, prefix, pre-signed URL expiry, and whether an
access key is present, but never prints the access key secret.

The last-run section reports:

- `status`
- `first_error_code`
- `error_layer`
- `trace_status`
- `trace_path`
- `artifacts_dir`
- `user_message`

## Session Inspection

`mini-agent session show <id>` loads in strict mode and prints:

- the session header
- `status`
- all parsed entries
- `repair-report` when corruption is detected

`mini-agent session show <id> --recover` switches to recover mode and prints only the longest valid prefix when the session tail is malformed.

`mini-agent session show <id> --trace` renders the linked run timelines. If the session comes from v1.1 and has no `runId` links, the command degrades to `trace	(no trace data)`.

## Run Inspection

Run traces are append-only JSONL event streams with one metadata file per run.

`mini-agent run list` prints the newest runs first.

`mini-agent run show <id>` supports:

- compact timeline
- verbose timeline
- JSON trace object
- JSONL raw event stream
- markdown summary
- recover mode for truncated traces

## Session Files

Default session path:

```text
.mini-agent/sessions/<timestamp>_<session-id>.jsonl
```

Default run path:

```text
.mini-agent/runs/<run-id>/
  meta.json
  trace.jsonl
  artifacts/
```

Last-run diagnostics snapshot:

```text
.mini-agent/diagnostics/last-run.json
```

Corruption repair reports:

```text
.mini-agent/artifacts/reports/<session-stem>-repair-report.txt
```

Shell artifacts:

```text
.mini-agent/runs/<run-id>/artifacts/bash/<tool-call-id>.log
```
