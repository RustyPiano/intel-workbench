# mini-agent Runtime

`mini-agent` is the local-first Agent Runtime used as Intel Workbench infrastructure. It remains a reusable core package for deterministic agent loops, tool execution, skills, sessions, and run traces.

## Capabilities

- deterministic runtime loop with a replaceable OpenAI-compatible model adapter
- built-in `read`, `write`, `edit`, `bash`, and `activate_skill` tools
- skill discovery and activation
- JSONL session persistence
- per-run trace capture under `.mini-agent/runs/<run-id>/`
- compact/verbose timeline rendering
- CLI one-shot and REPL modes
- `run list`, `run show`, `session show --trace`, and `doctor` commands

## Install And Verify

From the repository root:

```bash
npm install
npm run build -w mini-agent
npm run test:run -- packages/core
```

## Quick Start

Configure an OpenAI-compatible endpoint:

```bash
export MINI_AGENT_PROVIDER=openai-compatible
export MINI_AGENT_MODEL=your-model
export MINI_AGENT_BASE_URL=https://your-endpoint.example.com/v1
export MINI_AGENT_API_KEY=your-api-key
```

Run a single prompt:

```bash
npm run dev -w mini-agent -- "Summarize the workspace"
```

Open the interactive shell:

```bash
npm run dev -w mini-agent
```

Utility commands:

```bash
npm run dev -w mini-agent -- skills list
npm run dev -w mini-agent -- run list
npm run dev -w mini-agent -- run show <run-id>
npm run dev -w mini-agent -- session list
npm run dev -w mini-agent -- session show <session-id> --trace
npm run dev -w mini-agent -- doctor --last-run
npm run dev -w mini-agent -- doctor
```

## Compatibility Notes

- `RuntimeAgent.create(options)` is the supported construction path.
- `RuntimeConversation.send` serializes overlapping calls on the same conversation.
- Tool input schemas are `zod` schemas; `getToolJsonSchema(tool)` derives strict JSON Schema for model adapters.
- `bash` artifact snapshots are opt-in with `track_artifacts: true`.
- `write` and `edit` use atomic temp-file-plus-rename writes.
- `RunStatus` is monotonic: `pending -> running -> finalizing -> completed | failed | cancelled`.
- `EventBus` is bounded; use `getBufferedEvents()`.
- Trace redaction runs before prompt/session content is stored.

## Media Runtime Tools

The runtime includes `probe_media`, `analyze_media`, and `analyze_audio` for agent-level media inspection. These are generic runtime tools and are separate from the Intel Workbench product pipeline.

Cloud media providers such as DashScope, Doubao ASR, and Volcano TOS can be configured for development experiments, but product deployments should prefer local or controlled internal services.
