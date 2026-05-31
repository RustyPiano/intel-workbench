# Connect To OpenAI-Compatible Models

Use this guide when you want to point `mini-agent` at OpenAI or any endpoint that speaks the OpenAI Chat Completions shape used by the runtime adapter.

For Alibaba Cloud Model Studio / Bailian / DashScope, use the guided setup in
[Configure Alibaba Cloud Bailian / DashScope](./configure-alibaba-bailian.md).

## Use environment variables

This is the safest default because it keeps the API key out of shell history.

```bash
export MINI_AGENT_PROVIDER=openai-compatible
export MINI_AGENT_MODEL=gpt-4.1
export MINI_AGENT_API_KEY=your-api-key
export MINI_AGENT_BASE_URL=https://your-endpoint.example.com/v1
```

Then run:

```bash
npm run dev -- doctor
```

## Use CLI flags

Use flags when you need a one-off connection override:

```bash
npm run dev -- \
  --provider openai-compatible \
  --model gpt-4.1 \
  --base-url https://your-endpoint.example.com/v1 \
  --api-key your-api-key \
  "Review the repository"
```

This is convenient, but the API key will usually be visible in shell history and process lists.

## Use `mini-agent.config.json`

Create this file in the workspace root:

```json
{
  "provider": "openai-compatible",
  "model": "gpt-4.1",
  "baseURL": "https://your-endpoint.example.com/v1",
  "apiKey": "your-api-key",
  "maxTurns": 12
}
```

Then run:

```bash
npm run dev -- doctor
```

## Override precedence

The runtime resolves connection settings in this order:

1. CLI flags
2. Environment variables
3. `mini-agent.config.json`
4. Built-in defaults

## Troubleshoot connection setup

### `api_key missing` in `doctor`

Set one of:

- `MINI_AGENT_API_KEY`
- `apiKey` in `mini-agent.config.json`
- `--api-key` on the CLI

### The endpoint is wrong

Set one of:

- `MINI_AGENT_BASE_URL`
- `baseURL` in `mini-agent.config.json`
- `--base-url` on the CLI

### The model name is rejected by the provider

Change one of:

- `MINI_AGENT_MODEL`
- `model` in `mini-agent.config.json`
- `--model` on the CLI

### You want the default OpenAI endpoint

Do not set `baseURL`. The OpenAI SDK will use its default API base.
