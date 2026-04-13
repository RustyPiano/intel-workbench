# Model Adapter

This document describes the adapter layer between the runtime and model providers.

## Interface

The runtime depends on the `ModelAdapter` interface:

```ts
interface GenerateInput {
  systemPrompt: string
  messages: RuntimeMessage[]
  tools: ToolSpec[]
  signal?: AbortSignal
  temperature?: number
  maxTokens?: number
}

interface GenerateResult {
  message: AssistantMessage
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "error"
  usage?: {
    inputTokens?: number
    outputTokens?: number
  }
  rawResponse?: unknown
}

interface ModelAdapter {
  name: string
  generate(input: GenerateInput): Promise<GenerateResult>
  stream?(input: GenerateInput): AsyncIterable<unknown>
}
```

`mini-agent` currently ships one provider implementation: `openai-compatible`.

## Provider selection

`createModelAdapter()` dispatches on `provider`.

Current supported value:

- `openai-compatible`

Any other provider string raises `MODEL_ERROR`.

## OpenAI-compatible adapter

The adapter uses the OpenAI Node SDK and can target:

- the default OpenAI API when `baseURL` is omitted
- any endpoint that accepts the same Chat Completions shape when `baseURL` is provided

Connection fields:

- `provider`
- `model`
- `apiKey`
- `baseURL`

## Message mapping

Runtime messages are translated into OpenAI Chat Completions messages.

### Runtime `system`

```json
{ "role": "system", "content": "..." }
```

### Runtime `user`

```json
{ "role": "user", "content": "..." }
```

### Runtime `assistant`

Assistant tool intent is carried in `tool_calls`.

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_123",
      "type": "function",
      "function": {
        "name": "read",
        "arguments": "{\"path\":\"README.md\"}"
      }
    }
  ]
}
```

### Runtime `tool`

Tool results are replayed as OpenAI `tool` messages and must include `tool_call_id`.

## Tool schema mapping

The runtime exposes each tool as an OpenAI function tool:

```json
{
  "type": "function",
  "function": {
    "name": "read",
    "description": "Read a UTF-8 text file within the workspace.",
    "parameters": { "...": "JSON schema" },
    "strict": true
  }
}
```

## Stop-reason mapping

Current mapping:

- `tool_calls` or `function_call` -> `tool_use`
- `length` -> `max_tokens`
- everything else -> `end_turn`

## Error surfacing

Provider errors are normalized into `RuntimeError` with `code: "MODEL_ERROR"`.

The adapter preserves:

- HTTP status when present
- provider name when present
- provider-specific code
- parsed upstream status from embedded raw payloads
- whether the error came from BYOK mode when the provider exposes it

Current diagnostic categories are:

- `auth`
- `quota`
- `unsupported_model`
- `network`
- `provider`

The category is inferred from both transport status and provider-supplied message text.

## Tool-call parsing

Incoming provider tool calls are rejected unless:

- `type === "function"`
- `function.arguments` parses as JSON

Invalid tool payloads become `MODEL_ERROR` before the runtime loop tries to execute anything.

## Signal propagation

`generate()` passes `input.signal` into the SDK request options.

That gives the runtime one cancellation path across:

- model generation
- tool execution
- bash subprocess termination

## Notes for adding another provider

A new adapter should preserve the same runtime semantics:

- same `GenerateInput` and `GenerateResult` shape
- same runtime message roles
- same tool-spec contract
- structured `MODEL_ERROR` output instead of raw SDK exceptions
