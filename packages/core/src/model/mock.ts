import type { GenerateInput, GenerateResult, ModelAdapter, ModelStreamEvent } from "./types.js";

export class ScriptedModelAdapter implements ModelAdapter {
  readonly name = "mock";
  readonly inputs: GenerateInput[] = [];
  private readonly responses: GenerateResult[];
  private index = 0;

  constructor(responses: GenerateResult[], private readonly streamChunkSize?: number) {
    this.responses = responses;
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    this.inputs.push(input);

    const response = this.responses[this.index];
    if (!response) {
      throw new Error(`No scripted response for generate call ${this.index}`);
    }

    this.index += 1;
    return response;
  }

  async *stream(input: GenerateInput): AsyncIterable<ModelStreamEvent> {
    this.inputs.push(input);

    const response = this.responses[this.index];
    if (!response) {
      throw new Error(`No scripted response for generate call ${this.index}`);
    }

    this.index += 1;

    const content = response.message.content;
    if (content.length > 0) {
      if (typeof this.streamChunkSize === "number" && this.streamChunkSize > 0) {
        for (let offset = 0; offset < content.length; offset += this.streamChunkSize) {
          yield { type: "text_delta", text: content.slice(offset, offset + this.streamChunkSize) };
        }
      } else {
        yield { type: "text_delta", text: content };
      }
    }

    for (const [index, toolCall] of (response.message.toolCalls ?? []).entries()) {
      yield {
        type: "tool_call_delta",
        index,
        id: toolCall.id,
        name: toolCall.name,
        argumentsDelta: JSON.stringify(toolCall.arguments),
      };
    }

    yield { type: "complete", result: response };
  }
}
