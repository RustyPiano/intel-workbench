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
  // Provider thinking/reasoning toggle (DeepSeek `thinking:{type}` shape).
  // Forwarded verbatim to the request body when set; omitted otherwise.
  thinking?: { type: "enabled" | "disabled" }
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

type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "complete"; result: GenerateResult }

interface ModelAdapter {
  name: string
  generate(input: GenerateInput): Promise<GenerateResult>
  stream?(input: GenerateInput): AsyncIterable<ModelStreamEvent>
}
```

`mini-agent` currently ships one provider implementation: `openai-compatible`.

## Streaming (`stream()`)

Adapters that implement `stream()` yield provider deltas as they arrive, accumulate them internally, then yield exactly one final `complete` event carrying the assembled `GenerateResult` — identical in shape and content to what `generate()` would return for the same provider response. `complete` is always last; nothing is yielded after it.

`ModelStreamEvent` variants:

- `text_delta` — an incremental chunk of assistant message text
- `reasoning_delta` — an incremental chunk of provider reasoning/thinking content (e.g. DeepSeek `reasoning_content`). This is a streaming-only signal: it is not folded into the assembled message content, so the final `complete` result stays identical to `generate()` for the same response
- `tool_call_delta` — an index-addressed increment of a streamed tool call's `id`, `name`, and/or `argumentsDelta`, accumulated by the adapter and assembled into the final tool calls
- `complete` — the terminal event, carrying the fully assembled `GenerateResult`

Streamed `usage` can be `undefined` if a provider ignores `stream_options.include_usage`, so the assembled result's `usage` may diverge from `generate()`'s for such providers.

## Provider selection

`createModelAdapter()` dispatches on `provider`.

Current supported value:

- `openai-compatible`

Any other provider string raises `MODEL_ERROR`.

## OpenAI-compatible adapter

The adapter uses the OpenAI Node SDK and can target:

- the default OpenAI API when `baseURL` is omitted
- any endpoint that accepts the same Chat Completions shape when `baseURL` is provided

The SDK is constructed with a custom fetch that uses `redirect: "error"`. Model requests therefore fail instead of following an HTTP redirect to an unreviewed host.

Connection fields:

- `provider`
- `model`
- `apiKey`
- `baseURL`

When `input.thinking` is set, both `generate()` and `stream()` forward it verbatim as a non-standard `thinking` field on the request body (DeepSeek's `thinking:{type}` toggle). It is omitted from the request when not set.

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
- `stop` -> `end_turn`
- null, unknown, or provider-specific reasons -> `error`

The runtime loop also fails closed when a provider reports tool use without a tool call, reports an error stop, or reaches `max_tokens` without a usable tool call.

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

Incoming provider tool calls are accepted only when:

- `type === "function"`
- `function.arguments` is a string containing a JSON object, or can be conservatively rescued by removing a code fence / trailing text after the first balanced object

When string arguments still cannot be parsed, the adapter records a bounded `argumentsParseError` instead of executing the tool. The runtime journals a failed tool result and feeds it back to the model so the model can resend valid arguments. Missing arguments, object-shaped arguments, unsupported tool-call types, malformed choices, and unknown response shapes remain fail-closed `MODEL_ERROR` cases.

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
