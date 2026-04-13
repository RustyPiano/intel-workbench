# Session Format

This document describes the JSONL session format used by the current `mini-agent` runtime.

## File layout

Sessions are stored under:

```text
.mini-agent/sessions/<timestamp>_<session-id>.jsonl
```

Each line is one JSON object. Repair reports for damaged sessions are written under:

```text
.mini-agent/artifacts/reports/<session-stem>-repair-report.txt
```

Run traces are stored separately under:

```text
.mini-agent/runs/<run-id>/
  meta.json
  trace.jsonl
  artifacts/
```

The latest diagnostics snapshot is written to:

```text
.mini-agent/diagnostics/last-run.json
```

## Entry types

### `session_header`

The first line of every session file must be a header.

```json
{
  "type": "session_header",
  "version": 1,
  "sessionId": "sess_123",
  "createdAt": "2026-04-13T09:00:00.000Z",
  "workspaceRoot": "/workspace",
  "model": "gpt-4.1",
  "runtimeVersion": "1.1.0"
}
```

Required rules:

- exactly one header
- header must be line 1
- `sessionId` must match the session being loaded

### `message`

Conversation messages are stored as `message` entries.

```json
{
  "type": "message",
  "role": "assistant",
  "messageId": "msg_123",
  "timestamp": "2026-04-13T09:00:01.000Z",
  "runId": "run_123",
  "content": "I will read the file first.",
  "toolCalls": [
    {
      "id": "call_123",
      "name": "read",
      "arguments": {
        "path": "README.md"
      }
    }
  ]
}
```

Current roles are:

- `system`
- `user`
- `assistant`
- `tool`

`assistant` messages may declare `toolCalls`. Replayed `tool` messages are synthesized from `tool_result` entries when a session is resumed.

In v1.2 and later, user, assistant, tool-call, tool-result, skill-activation, and error entries may include `runId` to link the session transcript back to one run trace.

### `tool_call`

Each requested tool call is logged separately.

```json
{
  "type": "tool_call",
  "toolCallId": "call_123",
  "toolName": "read",
  "runId": "run_123",
  "args": {
    "path": "README.md"
  },
  "timestamp": "2026-04-13T09:00:02.000Z"
}
```

### `tool_result`

Each tool result closes one `tool_call`.

```json
{
  "type": "tool_result",
  "toolCallId": "call_123",
  "ok": true,
  "content": "# README",
  "timestamp": "2026-04-13T09:00:03.000Z",
  "runId": "run_123",
  "meta": {
    "path": "/workspace/README.md",
    "offset": 0,
    "limit": 262144,
    "truncated": false,
    "size": 1024
  }
}
```

Compatibility note:

- old session files may still contain `data`
- resume logic prefers `meta` and falls back to `data`

### `skill_activation`

Skill activation is recorded only after a successful `activate_skill` result.

```json
{
  "type": "skill_activation",
  "skill": "intel-bulletin",
  "contentHash": "sha256:...",
  "timestamp": "2026-04-13T09:00:04.000Z",
  "runId": "run_123"
}
```

### `error`

Structured runtime failures terminate the current turn.

```json
{
  "type": "error",
  "timestamp": "2026-04-13T09:00:05.000Z",
  "runId": "run_123",
  "error": {
    "code": "MODEL_ERROR",
    "message": "429 Provider returned error",
    "retriable": true
  }
}
```

### `event`

`event` is reserved for structured runtime events. It exists in the session type surface, but current resume logic does not depend on it.

## Ordering rules

The loader currently enforces these ordering checks:

1. The file must start with `session_header`.
2. A `tool_call` must have been declared by the immediately preceding assistant tool-call message.
3. A `tool_result` must match an earlier open `tool_call`.
4. A new `message` cannot appear while earlier tool calls are still open.
5. `skill_activation` must immediately follow a successful `activate_skill` result.

If any of these checks fail, the session stops being recoverable as a full replay.

## Loader modes

### `strict`

Use strict mode for normal resume. A corrupted session is rejected.

Properties:

- reads the full file
- records repair notes when corruption is found
- returns `status: "corrupted"` for invalid sessions
- keeps the original file unchanged

### `recover`

Use recover mode for inspection and partial salvage.

Properties:

- loads only the longest valid prefix
- stops at the first malformed or out-of-order entry
- writes a repair report
- returns `status: "degraded"` when a valid prefix exists and the header is recoverable

If the header itself is missing or invalid, recover mode still reports `corrupted`.

## Health states

### `valid`

- header is present
- no ordering or parse errors were found
- safe to resume

### `degraded`

- header is valid
- a recoverable prefix exists
- safe to inspect
- not used for strict resume

### `corrupted`

- header is missing or invalid, or
- the session cannot be resumed safely

## Resume behavior

The runtime resumes only through strict loading.

During resume it rebuilds:

- prior conversation messages
- prior tool results as `role: "tool"` messages
- activated skills through `SkillRegistry.activate()`

That means a resumed conversation has both the assistant tool calls and the corresponding tool-result transcript in memory.

## Run trace linkage

v1.2 keeps the session grammar backward-compatible by storing run traces outside the session JSONL and linking them back through `runId`.

`meta.json` stores run-level counters and terminal status:

- `run_id`
- `trace_id`
- `session_id`
- `status`
- `started_at`
- `ended_at`
- `provider`
- `model`
- `duration_ms`
- `tool_calls`
- `skill_activations`
- `artifact_count`
- `first_error_code`

`trace.jsonl` stores one run event per line. Each event includes:

- `schema_version`
- `event_id`
- `trace_id`
- `run_id`
- optional `session_id`
- `seq`
- `ts`
- `type`
- `phase`
- `level`
- `summary`
- optional `data`

Recover mode for run traces follows the same principle as session recover mode: the loader returns the longest valid prefix and marks the trace as `degraded` instead of claiming it is fully valid.
