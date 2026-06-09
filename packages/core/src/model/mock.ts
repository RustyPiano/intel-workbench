import type { ModelAdapter, GenerateInput, GenerateResult } from "./types.js";

export class ScriptedModelAdapter implements ModelAdapter {
  readonly name = "mock";
  readonly inputs: GenerateInput[] = [];
  private readonly responses: GenerateResult[];
  private index = 0;

  constructor(responses: GenerateResult[]) {
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
}
