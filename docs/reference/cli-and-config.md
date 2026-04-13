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
| `--json-events` | Emit runtime events as JSON lines. |
| `--read-only` | Disallow writes through the runtime. |
| `--max-turns <n>` | Set the loop turn cap. |
| `--help` | Show usage. |

### Commands

| Command | Meaning |
| --- | --- |
| `mini-agent skills list` | Print discovered skills. |
| `mini-agent session list` | List saved sessions. |
| `mini-agent session show <id>` | Print a session header and entries. |
| `mini-agent doctor` | Print connection and workspace status. |

## Environment Variables

| Variable | Meaning |
| --- | --- |
| `MINI_AGENT_PROVIDER` | Provider name. |
| `MINI_AGENT_MODEL` | Model name. |
| `MINI_AGENT_BASE_URL` | Provider base URL. |
| `MINI_AGENT_API_KEY` | Provider API key. |
| `MINI_AGENT_SESSION_DIR` | Session directory override. |
| `MINI_AGENT_MAX_TURNS` | Loop turn cap. |
| `MINI_AGENT_TOOL_TIMEOUT_MS` | Generic tool timeout. |
| `MINI_AGENT_BASH_TIMEOUT_MS` | Bash timeout. |
| `MINI_AGENT_MAX_BASH_OUTPUT_BYTES` | Bash output tail size kept in context. |
| `MINI_AGENT_READ_MAX_BYTES` | Max bytes returned by `read`. |
| `MINI_AGENT_GLOBAL_SKILL_DIRS` | Comma-separated global skill directories. |
| `MINI_AGENT_ALLOW_READ_OUTSIDE_WORKSPACE` | Allow reads outside the workspace. |
| `MINI_AGENT_ALLOW_WRITE_OUTSIDE_WORKSPACE` | Allow writes outside the workspace. |
| `MINI_AGENT_JSON_EVENTS` | Enable JSON event output. |
| `MINI_AGENT_READ_ONLY` | Enable read-only mode. |

## `mini-agent.config.json`

### Supported keys

```json
{
  "provider": "openai-compatible",
  "model": "gpt-4.1",
  "baseURL": "https://your-endpoint.example.com/v1",
  "apiKey": "your-api-key",
  "workspaceRoot": ".",
  "sessionDir": ".mini-agent/sessions",
  "maxTurns": 12,
  "toolTimeoutMs": 60000,
  "bashTimeoutMs": 120000,
  "maxBashOutputBytes": 65536,
  "readMaxBytes": 262144,
  "globalSkillDirs": ["~/.agents/skills"],
  "allowReadOutsideWorkspace": false,
  "allowWriteOutsideWorkspace": false,
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

## Session Files

Default session path:

```text
.mini-agent/sessions/<timestamp>_<session-id>.jsonl
```

Corruption repair reports:

```text
.mini-agent/artifacts/reports/<session-stem>-repair-report.txt
```

Shell artifacts:

```text
.mini-agent/artifacts/bash/<tool-call-id>.log
```
