# mini-agent

`mini-agent` is a local-first agent runtime implemented from the project spec in [docs/mini-agent-runtime-spec.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/mini-agent-runtime-spec.md).

It provides:

- a deterministic agent loop
- a replaceable model adapter interface
- built-in `read`, `write`, `edit`, `bash`, and `activate_skill` tools
- skill discovery and activation
- JSONL session persistence
- per-run trace capture with timeline rendering
- a small CLI with one-shot and REPL execution modes

## What v1.2 adds

- Run-scoped trace storage under `.mini-agent/runs/<run-id>/`
- Compact and verbose timeline output in one-shot and REPL execution
- `run list` and `run show`
- `session show --trace`
- `doctor --last-run` and `doctor --run <id>`
- Safe planning/progress summaries instead of raw private reasoning
- Run-level artifact visibility for file writes, edits, and bash logs/output

## What v1.3 adds (next release, breaking)

- **`RuntimeAgent.create(options)`** is the only supported construction
  path; the previous `new RuntimeAgent(...)` two-phase initialization is
  gone (`skillRegistry` and `policy` are now `readonly` and resolved
  before the instance exists).
- **`RuntimeConversation.send` is concurrency-safe**: overlapping calls
  on the same conversation serialize through an internal queue, so
  `messages` and the session JSONL stay consistent.
- **System prompt is cached per conversation.** `AGENTS.md` is read
  once; `<active_skills>` is rebuilt only when the active set actually
  changes.
- **Tool input schemas are now `zod` schemas.** `RuntimeTool.inputSchema`
  is a `z.ZodTypeAny`; `getToolJsonSchema(tool)` derives the JSON Schema
  forwarded to the model with `additionalProperties: false` and every
  declared property in `required` (OpenAI strict-mode compatible).
- **`bash` snapshot is opt-in.** Pass `track_artifacts: true` to have
  the tool diff the workspace and report created files. Default `false`
  keeps every `bash` call O(commanded work). The new ignore list adds
  `.git`, `dist`, `build`, `.next`, `.cache`, `.turbo`, `coverage`,
  `.venv`, `.pytest_cache`, and `*.log`.
- **Atomic writes.** Both `write` and `edit` go through
  `atomicWriteFile` (`tmp + rename` with random suffix); partial writes
  no longer leave half-files in the workspace.
- **`RunStatus` collapses to 5 monotonic values**: `pending → running →
  finalizing → (completed | failed | cancelled)`. The previous
  `planning ↔ executing` oscillation is gone (the phase distinction
  moves onto events).
- **`EventBus` is bounded.** Defaults to a ring buffer of 2000 events
  exposed via `getBufferedEvents()`; the old unbounded `events` field is
  removed.
- **New error codes** with friendly user messages:
  `SESSION_NOT_FOUND`, `MAX_TURNS_EXCEEDED`, `PATH_NOT_ALLOWED`
  (replaces ad-hoc `Error` throws from `PolicyEngine`). Reaching the
  turn limit now ends the run as `failed`, not `completed`.
- **CLI argv hardening.** Missing values, unknown flags
  (`--frobnicate`), bad `--trace` enum values, and non-positive
  `--max-turns` all exit non-zero with a clear `CliError` message.
- **CLI entry point moved.** `bin` is now `dist/src/cli/bin.js` (and
  `npm run dev` uses `tsx src/cli/bin.ts`); `src/cli/main.ts` only
  exports the CLI building blocks.
- **Sensitive paths.** `~/.aws`, `~/.gnupg`, `/root`, `/var/run/docker.sock`
  join `/etc` and `~/.ssh` in the policy blocklist. `~/.config` is
  deliberately omitted so dev-tool configs in there remain reachable.
- **Trace redaction.** `redact → normalize → truncate` ordering plus new
  patterns for Slack `xox[abprs]-`, GitHub `gh{p,o,u,s,r}_`, and AWS
  `AKIA…` tokens. `AGENTS.md` content is redacted before it enters the
  system prompt.

### Migration notes

- Any external code that did `new RuntimeAgent(...)` needs to switch to
  `await RuntimeAgent.create(...)`.
- Tool authors must replace JSON Schema `inputSchema` with a zod
  schema. Use `getToolJsonSchema(tool)` to obtain a JSON Schema if you
  forward tools to your own model adapter.
- Existing `bash` callers that relied on seeing newly created files in
  artifacts need to pass `track_artifacts: true`.
- Consumers reading `EventBus.events` directly must call
  `getBufferedEvents()` instead.
- Scripts that checked for `status === "planning"` or `"executing"`
  should switch to `status === "running"`.

## Install And Verify

Install dependencies and run the verification suite:

```bash
npm install
npm run check
```

Build the CLI:

```bash
npm run build
```

## Quick Start

Set your connection through environment variables:

```bash
export MINI_AGENT_PROVIDER=openai-compatible
export MINI_AGENT_MODEL=gpt-4.1
export MINI_AGENT_API_KEY=your-api-key
```

For an OpenAI-compatible endpoint, also set:

```bash
export MINI_AGENT_BASE_URL=https://your-endpoint.example.com/v1
```

Run a single prompt:

```bash
npm run dev -- "Summarize the workspace"
```

Open the interactive shell:

```bash
npm run dev
```

Utility commands:

```bash
npm run dev -- skills list
npm run dev -- run list
npm run dev -- run show <run-id>
npm run dev -- session list
npm run dev -- session show <session-id> --trace
npm run dev -- doctor --last-run
npm run dev -- doctor
```

## Connection Options

`mini-agent` currently exposes one provider: `openai-compatible`.

You can configure it in three places, highest priority first:

1. CLI flags
2. Environment variables
3. `mini-agent.config.json`

Supported connection settings:

- `provider`
- `model`
- `baseURL`
- `apiKey`

Example CLI invocation:

```bash
npm run dev -- \
  --provider openai-compatible \
  --model gpt-4.1 \
  --base-url https://your-endpoint.example.com/v1 \
  --api-key your-api-key \
  "Review this repository"
```

Example `mini-agent.config.json`:

```json
{
  "provider": "openai-compatible",
  "model": "gpt-4.1",
  "baseURL": "https://your-endpoint.example.com/v1",
  "apiKey": "your-api-key",
  "maxTurns": 12
}
```

## Media Tool Connections

The `probe_media`, `analyze_media`, and `analyze_audio` tools let the agent
inspect and understand media while the runtime itself remains text-only.
`analyze_media` handles video/image through a multimodal model. `analyze_audio`
handles pure audio through Doubao recording ASR.

Start with the smallest setup for the task:

| Task | Configure | Notes |
| --- | --- | --- |
| Text-only agent | `MINI_AGENT_MODEL`, `MINI_AGENT_API_KEY`, optional `MINI_AGENT_BASE_URL` | No media variables needed. |
| Video/image analysis | Add `MINI_AGENT_MM_MODEL`; add `MINI_AGENT_MM_BASE_URL` / `MINI_AGENT_MM_API_KEY` only when different from the primary connection. | `analyze_media` activates only when `mmModel` is set. |
| Fast local audio transcription | Add ASR auth, then call `analyze_audio` with `engine: "turbo"`. | Turbo can inline wav/mp3/ogg/opus local files without TOS. |
| Rich, long, large, or original-format audio | Add ASR auth, call `engine: "standard"`, and provide a reachable URL or configure TOS for local files. | Standard supports richer metadata and broader formats. |
| Large local video/image URL path | Configure TOS only when inline Base64 is not enough. | Buckets should stay private; mini-agent uses short-lived pre-signed URLs. |

Both media analysis tools return inline results by default. The agent may pass
`out_path` to write the full JSON result to disk and return only a short summary
plus the path; prefer this for long transcripts or large structured outputs.

### Multimodal video/image

Configure it independently of the primary connection. `baseURL` and `apiKey`
fall back to the primary connection when omitted:

```bash
export MINI_AGENT_MM_MODEL=qwen3.5-omni-plus
export MINI_AGENT_MM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
export MINI_AGENT_MM_API_KEY=your-dashscope-key
# Optional: give long media analysis a larger budget than normal tools.
export MINI_AGENT_MM_TIMEOUT_MS=180000
```

Or in `mini-agent.config.json`: `mmProvider`, `mmModel`, `mmBaseURL`,
`mmApiKey`, `mmTimeoutMs`.

Verify with `npm run dev -- doctor` and the `[multimodal_path]` section.
`probe_media` requires `ffprobe` from `ffmpeg` on the `PATH`.

For DashScope Qwen-Omni local files, `analyze_media` sends inline Base64 content
and enforces DashScope's encoded payload limit of 10MB. For larger local files,
configure optional Volcano Engine TOS upload so mini-agent can pass a
short-lived pre-signed URL. Existing reachable video/image URLs can be sent
directly; URL calls require `kind`.

`qwen3.5-omni-plus` does not provide native structured output on this path, so
`want_json` uses prompt-plus-parse. A/V report workflows should run
`validate_analysis.py` before merge/render; unparseable model output is rejected
so the agent can retry once or produce degraded output.

### Doubao audio ASR

Pure audio uses `analyze_audio` with explicit `engine: "standard" | "turbo"`.
There is no global default engine; the agent should choose per request from the
tool description and user intent.

- `turbo` (`volc.bigasr.auc_turbo`): faster one-shot transcription, speaker
  separation, local inline audio without TOS, but only wav/mp3/ogg/opus and no
  emotion/gender/speech-rate/volume.
- `standard` (`volc.seedasr.auc`): submit-and-poll flow, broader formats,
  long/large audio, and richer metadata; local files need TOS or another
  model-reachable URL.

When a local file is not in a turbo-supported format and rich metadata is not
required, the agent should try local conversion with `ffmpeg` before asking the
user to configure TOS.

Doubao ASR auth is separate from the primary text connection and the multimodal
connection. Configure one auth mode:

```bash
export MINI_AGENT_ASR_API_KEY=your-doubao-api-key
# or:
export MINI_AGENT_ASR_APP_KEY=your-doubao-app-key
export MINI_AGENT_ASR_ACCESS_KEY=your-doubao-access-key

# Optional:
export MINI_AGENT_ASR_APP_ID=your-app-id
export MINI_AGENT_ASR_RESOURCE_ID=volc.seedasr.auc
export MINI_AGENT_ASR_TURBO_RESOURCE_ID=volc.bigasr.auc_turbo
export MINI_AGENT_ASR_TURBO_MAX_BYTES=20000000
export MINI_AGENT_ASR_BASE_URL=https://openspeech.bytedance.com
export MINI_AGENT_ASR_TIMEOUT_MS=180000
```

Or in `mini-agent.config.json`: `asrAppId`, `asrApiKey`, `asrAccessKey`,
`asrAppKey`, `asrResourceId`, `asrTurboResourceId`, `asrTurboMaxBytes`,
`asrBaseURL`, `asrTimeoutMs`.

Verify setup with `npm run dev -- doctor` and the `[asr_path]` section.

TOS is not required for first startup or ordinary text use. Start with the
primary model connection, then add multimodal, ASR, and TOS only when local
media needs it. See [Configure Volcano Engine TOS for local media](/Users/wangsiyuan/编程/小项目/mini-agent/docs/how-to/configure-volcengine-tos.md).

## CLI Surface

```bash
mini-agent [prompt]
  --cwd <path>
  --provider <name>
  --model <name>
  --base-url <url>
  --api-key <token>
  --session <id>
  --skill-dir <path>
  --trace compact|verbose|json
  --show-plan
  --hide-debug
  --json-events
  --read-only
  --max-turns <n>
  --help
```

Commands:

- `mini-agent skills list`
- `mini-agent run list`
- `mini-agent run show <id> [--format timeline|json|jsonl|markdown] [--verbose] [--recover]`
- `mini-agent session list`
- `mini-agent session show <id> [--recover] [--trace] [--run <id>]`
- `mini-agent doctor [--last-run | --run <id>]`

## Documentation Map

- Tutorial: [docs/tutorials/quickstart.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/tutorials/quickstart.md)
- How-to: [docs/how-to/connect-openai-compatible-models.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/how-to/connect-openai-compatible-models.md)
- How-to: [docs/how-to/configure-alibaba-bailian.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/how-to/configure-alibaba-bailian.md)
- How-to: [docs/how-to/configure-volcengine-tos.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/how-to/configure-volcengine-tos.md)
- Reference: [docs/reference/cli-and-config.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/reference/cli-and-config.md)
- Reference: [docs/reference/session-format.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/reference/session-format.md)
- Explanation: [docs/explanation/runtime-architecture.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/explanation/runtime-architecture.md)
- Example skill (text): [.agents/skills/intel-bulletin](/Users/wangsiyuan/编程/小项目/mini-agent/.agents/skills/intel-bulletin)
- Example skill (multimodal): [.agents/skills/av-dialogue-insight](/Users/wangsiyuan/编程/小项目/mini-agent/.agents/skills/av-dialogue-insight)
- App specs: [docs/specs/](/Users/wangsiyuan/编程/小项目/mini-agent/docs/specs)
- Practice report: [docs/report/practice-report.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/report/practice-report.md)
