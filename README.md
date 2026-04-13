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
- Reference: [docs/reference/cli-and-config.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/reference/cli-and-config.md)
- Reference: [docs/reference/session-format.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/reference/session-format.md)
- Explanation: [docs/explanation/runtime-architecture.md](/Users/wangsiyuan/编程/小项目/mini-agent/docs/explanation/runtime-architecture.md)
- Example skill: [.agents/skills/intel-bulletin](/Users/wangsiyuan/编程/小项目/mini-agent/.agents/skills/intel-bulletin)
