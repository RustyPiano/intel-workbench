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

| Variable | Meaning |
| --- | --- |
| `MINI_AGENT_PROVIDER` | Provider name. |
| `MINI_AGENT_MODEL` | Model name. |
| `MINI_AGENT_BASE_URL` | Provider base URL. |
| `MINI_AGENT_API_KEY` | Provider API key. |
| `MINI_AGENT_SMOKE_PROVIDER` | Optional known-good smoke-path provider name shown by `doctor`. |
| `MINI_AGENT_SMOKE_MODEL` | Optional known-good smoke-path model shown by `doctor`. |
| `MINI_AGENT_SMOKE_BASE_URL` | Optional known-good smoke-path base URL shown by `doctor`. |
| `MINI_AGENT_SESSION_DIR` | Session directory override. |
| `MINI_AGENT_MAX_TURNS` | Loop turn cap. |
| `MINI_AGENT_TOOL_TIMEOUT_MS` | Generic tool timeout. |
| `MINI_AGENT_BASH_TIMEOUT_MS` | Bash timeout. |
| `MINI_AGENT_MAX_BASH_OUTPUT_BYTES` | Bash output tail size kept in context. |
| `MINI_AGENT_READ_MAX_BYTES` | Max bytes returned by `read`. |
| `MINI_AGENT_GLOBAL_SKILL_DIRS` | Comma-separated global skill directories. |
| `MINI_AGENT_ALLOW_READ_OUTSIDE_WORKSPACE` | Allow reads outside the workspace. |
| `MINI_AGENT_ALLOW_WRITE_OUTSIDE_WORKSPACE` | Allow writes outside the workspace. |
| `MINI_AGENT_TRACE_MODE` | Default trace mode: `compact`, `verbose`, or `json`. |
| `MINI_AGENT_SHOW_PLAN` | Show planning/progress summaries. |
| `MINI_AGENT_HIDE_DEBUG` | Hide debug-only details in verbose output. |
| `MINI_AGENT_JSON_EVENTS` | Enable JSON event output. |
| `MINI_AGENT_READ_ONLY` | Enable read-only mode. |
| `MINI_AGENT_TOS_ACCESS_KEY_ID` | Volcano Engine TOS access key ID for optional local media upload. |
| `MINI_AGENT_TOS_ACCESS_KEY_SECRET` | Volcano Engine TOS access key secret for optional local media upload. |
| `MINI_AGENT_TOS_BUCKET` | TOS bucket used for optional local media upload. Keep it private. |
| `MINI_AGENT_TOS_REGION` | TOS bucket region, for example `cn-beijing`. |
| `MINI_AGENT_TOS_ENDPOINT` | Optional S3-protocol endpoint override. Defaults to `tos-s3-${MINI_AGENT_TOS_REGION}.volces.com` when region is set. A native `tos-<region>...` host is upgraded to the `tos-s3-<region>...` host automatically; a leading `https://` is optional. |
| `MINI_AGENT_TOS_PREFIX` | Optional object key prefix for uploaded local media. |
| `MINI_AGENT_TOS_SIGNED_URL_EXPIRES` | Optional pre-signed URL lifetime in seconds. Defaults to `3600`. |

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
  "workspaceRoot": ".",
  "sessionDir": ".mini-agent/sessions",
  "maxTurns": 12,
  "toolTimeoutMs": 60000,
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

TOS is not needed for first startup. Configure the primary model first, then add
TOS only when large local video/image files or local audio need a
model-reachable URL.

mini-agent's TOS path is designed for private buckets plus short-lived
pre-signed GET URLs, not public-read buckets. The minimal environment variables
are:

```bash
export MINI_AGENT_TOS_ACCESS_KEY_ID=your-tos-ak
export MINI_AGENT_TOS_ACCESS_KEY_SECRET=your-tos-sk
export MINI_AGENT_TOS_BUCKET=your-bucket
export MINI_AGENT_TOS_REGION=cn-beijing
```

Optional settings:

```bash
export MINI_AGENT_TOS_PREFIX=mini-agent/uploads
export MINI_AGENT_TOS_SIGNED_URL_EXPIRES=3600
# Optional only when overriding the region-derived endpoint (S3-protocol host):
export MINI_AGENT_TOS_ENDPOINT=tos-s3-cn-beijing.volces.com
```

Use the Volcano Engine TOS service and API references when creating the bucket,
credentials, and upload permissions:

- https://www.volcengine.com/docs/6349/74830?lang=zh
- https://www.volcengine.com/docs/6349/74837?lang=zh

See [Configure Volcano Engine TOS for local media](../how-to/configure-volcengine-tos.md)
for the full workflow.

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
