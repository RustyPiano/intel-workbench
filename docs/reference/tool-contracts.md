# Tool Contracts

This document describes the runtime-level contract applied to every built-in tool.

## Runtime tool interface

Each tool implements this shape:

```ts
interface RuntimeTool<TArgs = unknown, TResult = unknown> {
  name: string
  description: string
  inputSchema: JsonSchema
  execute(args: TArgs, ctx: ToolContext): Promise<ToolExecutionResult<TResult>>
}
```

The runtime does not call tools directly from model output. It routes every call through `ToolRegistry.execute()`.

## Result envelope

All tools return the same envelope:

```ts
interface ToolArtifact {
  type: "log" | "file" | "json"
  path: string
  description?: string
}

interface ToolExecutionResult<T = unknown> {
  ok: boolean
  content: string
  meta?: T
  error?: RuntimeErrorShape
  artifacts?: ToolArtifact[]
}
```

Rules:

- `content` is always the model-facing summary text
- `meta` carries structured machine-readable details
- failures return `ok: false` plus a structured `error`
- artifacts point at files the runtime created or exposed

## Runtime-level guardrails

`ToolRegistry.execute()` applies shared behavior before tool-specific logic runs.

### Argument validation

- unknown tool names fail with `INVALID_ARGS`
- object shape is checked against `inputSchema`
- missing required fields fail before the tool executes
- simple scalar and array type mismatches fail before the tool executes

### Timeout

- every tool call is bounded by `config.toolTimeoutMs`
- the registry creates a child `AbortController`
- timeout resolves to a structured `TOOL_TIMEOUT` result

### Abort propagation

- if the parent signal is already aborted, the tool does not start
- if the parent signal aborts during execution, the child signal is aborted too
- tools that support streaming or long-running work must observe `ctx.signal`

## Tool context

Every tool receives:

- `workspaceRoot`
- `sessionId`
- `toolCallId`
- `signal`
- `logger`
- `policy`
- `config`
- `fileMutationQueue` for write-capable tools
- `skillRegistry` for `activate_skill`
- `onUpdate` for streaming partial output

## Path policy

The policy engine enforces runtime boundaries before tools touch the filesystem.

### Reads

By default, reads are limited to:

- the workspace root
- discovered skill roots

`allowReadOutsideWorkspace` removes that boundary.

### Writes

By default, writes are limited to the workspace root only.

`allowWriteOutsideWorkspace` removes that boundary.

`readOnly` blocks writes entirely.

### Exec

`bash` resolves `cwd` inside the workspace only.

### Sensitive roots

Even with broader settings, some sensitive roots remain blocked, including:

- `/etc`
- `~/.ssh`

## File mutation queue

`write` and `edit` do not coordinate through the model. They coordinate through a per-path mutation queue.

Rules:

- writes are serialized by absolute target path
- concurrent writes to the same path do not overlap
- tools do not need to implement their own locking

## Built-in tools

### `read`

Contract:

- resolves the path through read policy
- counts `offset`/`limit` in lines (1-based `offset`, default first 2000 lines)
- prefixes each returned line with its line number and a tab (`<n>\t`), cat -n style
- caps the bytes scanned per read by `readMaxBytes`, and individual long lines by length
- keeps UTF-8 boundaries intact when the byte cap truncates

`meta` fields:

- `path`
- `offset` — 1-based line number of the first returned line
- `limit` — line limit applied
- `lines` — number of lines returned
- `truncated`
- `size` — file size in bytes

### `write`

Contract:

- resolves the path through write policy
- optionally creates parent directories
- refuses overwrite when `overwrite === false`
- writes through a temporary file and `rename()` for atomic replacement

`meta` fields:

- `path`
- `bytesWritten`

### `edit`

Contract:

- resolves the path through write policy
- normalizes text before matching
- rejects zero matches with `EDIT_NO_MATCH`
- rejects ambiguous matches unless `replace_all === true`

`meta` fields:

- `path`
- `replacements`

### `bash`

Contract:

- resolves `cwd` through exec policy
- per-call `timeout_ms` cannot exceed `bashTimeoutMs`
- streams partial output through `ctx.onUpdate`
- writes the full combined output to `.mini-agent/artifacts/bash/<tool-call-id>.log`
- keeps only bounded stdout, stderr, and combined tails in memory

`meta` fields:

- `exitCode`
- `stdoutTail`
- `stderrTail`
- `logPath`

Artifacts:

- one `log` artifact pointing at the full command log

### `activate_skill`

Contract:

- requires an attached skill registry
- resolves a skill by discovered name
- loads the full `SKILL.md` body on first activation
- inventories `scripts/`, `references/`, and `assets/` on activation

`meta` fields:

- `name`
- `rootDir`
- `contentHash`
- `newlyActivated`

## Session recording

The runtime persists `tool_call` and `tool_result` entries into the session log. `tool_result.meta` is the canonical structured metadata field.

Streaming tool updates are runtime events, not separate session entries.
