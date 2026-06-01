# Runtime Architecture

`mini-agent` keeps the runtime small on purpose. The project is easier to reason about when the runtime owns orchestration and the skills own task-specific behavior.

## Main pieces

### Runtime agent

The runtime agent coordinates one conversation:

- creates or resumes a session
- discovers skills
- builds policy
- runs the agent loop
- provides tool context

Implementation: [src/runtime/agent.ts](src/runtime/agent.ts)

### Agent loop

The loop is deterministic:

1. append the user message
2. build the system prompt
3. call the model
4. append the assistant message
5. execute any requested tools
6. append tool results
7. repeat until there are no tool calls or the max turn limit is reached

Implementation: [src/runtime/loop.ts](src/runtime/loop.ts)

### Model adapter layer

The runtime does not talk to a provider directly. It uses a model adapter interface so providers can be swapped without rewriting the runtime core.

In v1, the shipped provider is `openai-compatible`. It uses the OpenAI SDK, but it can point either at OpenAI itself or at a compatible endpoint through `baseURL`.

Implementation:

- [src/model/types.ts](src/model/types.ts)
- [src/model/factory.ts](src/model/factory.ts)
- [src/model/openai-compatible.ts](src/model/openai-compatible.ts)

### Tool layer

The built-in tools provide the runtime’s side effects:

- `read`
- `write`
- `edit`
- `bash`
- `activate_skill`

The file mutation queue serializes writes per path, which keeps concurrent writes from silently stomping each other.

Implementation: [src/tools/index.ts](src/tools/index.ts)

### Skill layer

Skills are discovered from configured directories, parsed from `SKILL.md`, and activated explicitly. The runtime injects only the skill catalog at startup and the full skill body only after activation.

That keeps prompt growth under control and matches the progressive-disclosure rule from the spec.

Implementation:

- [src/skills/discover.ts](src/skills/discover.ts)
- [src/skills/parse-skill.ts](src/skills/parse-skill.ts)
- [src/skills/registry.ts](src/skills/registry.ts)

### Session store

Sessions are plain JSONL files. That choice is deliberate:

- easy to inspect during debugging
- easy to replay
- easy to present in a course demo
- easy to recover partially if corruption happens

Implementation: [src/runtime/session.ts](src/runtime/session.ts)

## Why the provider config looks this way

The runtime separates:

- provider type
- model name
- base URL
- API key

That split matters because "OpenAI-compatible" is a protocol shape, not a single backend. The same adapter can talk to:

- the OpenAI API
- a proxy in front of OpenAI
- a hosted compatible gateway
- a local compatible server

The runtime should not care which of those it is talking to as long as the endpoint follows the expected API behavior.
