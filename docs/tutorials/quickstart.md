# Quickstart

This tutorial gets a fresh checkout from zero to one successful runtime command.

## Prerequisites

- Node.js 20 or newer
- npm
- An API key for an OpenAI-compatible endpoint

## 1. Install dependencies

```bash
npm install
```

## 2. Set model connection variables

For the default OpenAI endpoint:

```bash
export MINI_AGENT_PROVIDER=openai-compatible
export MINI_AGENT_MODEL=gpt-4.1
export MINI_AGENT_API_KEY=your-api-key
```

For a compatible endpoint such as a proxy, hosted gateway, or local server:

```bash
export MINI_AGENT_PROVIDER=openai-compatible
export MINI_AGENT_MODEL=gpt-4.1
export MINI_AGENT_BASE_URL=https://your-endpoint.example.com/v1
export MINI_AGENT_API_KEY=your-api-key
```

## 3. Verify the local project

```bash
npm run check
```

Expected result:

- TypeScript passes
- Vitest passes

## 4. Inspect runtime status

```bash
npm run dev -- doctor
```

Check that:

- `provider` is `openai-compatible`
- `model` is the model you selected
- `api_key` is `configured`
- `base_url` matches your endpoint, or the default OpenAI endpoint is reported

## 5. Run a one-shot prompt

```bash
npm run dev -- "Summarize the project structure"
```

This starts a new session, builds the runtime prompt, and asks the model to respond or call tools.

## 6. Explore the bundled skill

```bash
npm run dev -- skills list
```

You should see `intel-bulletin` in the catalog.

## 7. Open the interactive shell

```bash
npm run dev
```

Type a prompt and press Enter. Type `exit`, `quit`, or `:q` to leave.

## What you have now

You have a working runtime with:

- verified local code
- a reachable model connection
- skill discovery
- single-shot and interactive execution
