import type { GenerateInput, GenerateResult, ModelAdapter, ModelStreamEvent } from "mini-agent";

/**
 * 脚本化流式适配器（测试缝）：按 search→read→cite→finalize→answer 的多轮回应驱动
 * inquiry agent，并据 scripted GenerateResult 合成 delta + 终态 complete。
 * 服务级（inquiry-stream）与路由级（api）测试共用，避免重复定义。
 */
function toolCall(name: string, args: Record<string, unknown>, id = `call_${name}`): GenerateResult {
  return {
    message: { role: "assistant", content: "", toolCalls: [{ id, name, arguments: args }] },
    stopReason: "tool_use",
  };
}

function final(content = "streamed narration"): GenerateResult {
  return { message: { role: "assistant", content }, stopReason: "end_turn" };
}

function toolResults(input: GenerateInput, name: string): { ok: boolean; content: string }[] {
  return input.messages
    .filter((message) => message.role === "tool" && message.toolName === name)
    .map((message) => JSON.parse(message.content) as { ok: boolean; content: string });
}

function firstSearchChunkId(input: GenerateInput): string {
  const [search] = toolResults(input, "search_chunks");
  const chunks = JSON.parse(search?.content ?? "[]") as { chunk_id: string }[];
  return chunks[0]?.chunk_id ?? "missing";
}

function citedIds(input: GenerateInput): string[] {
  return toolResults(input, "cite")
    .filter((result) => result.ok)
    .map((result) => {
      try {
        return (JSON.parse(result.content) as { cite_id?: string }).cite_id;
      } catch {
        return undefined;
      }
    })
    .filter((id): id is string => typeof id === "string");
}

export class StreamingInquiryAdapter implements ModelAdapter {
  readonly name = "streaming-agent";
  readonly inputs: GenerateInput[] = [];

  constructor(private readonly mode: "valid" | "invalid-cite" | "no-finalize" = "valid") {}

  async generate(input: GenerateInput): Promise<GenerateResult> {
    this.inputs.push(input);
    if (input.tools.length === 0) return final(JSON.stringify({ label: "supports", rationale: "test support label" }));
    const has = (name: string) => toolResults(input, name).length > 0;

    if (this.mode === "no-finalize") {
      return final("no finalized claims");
    }

    if (!has("search_chunks")) {
      return toolCall("search_chunks", { query: "舰船 线索", k: 6 }, `search_${this.inputs.length}`);
    }

    const chunkId = firstSearchChunkId(input);
    if (this.mode === "valid" && !has("read_chunk")) {
      return toolCall("read_chunk", { chunk_id: chunkId }, `read_${this.inputs.length}`);
    }

    if (!has("cite")) {
      const citeId = this.mode === "invalid-cite" ? "not-returned#999" : chunkId;
      return toolCall("cite", { chunk_id: citeId, claim: "发现舰船线索", quote: "舰船线索" }, `cite_${this.inputs.length}`);
    }

    if (!has("finalize_answer")) {
      const citeId = this.mode === "invalid-cite" ? "not-returned#999" : (citedIds(input)[0] ?? "missing-cite-id");
      return toolCall("finalize_answer", { claims: [{ text: "发现舰船线索", cite_ids: [citeId] }] }, `final_${this.inputs.length}`);
    }

    return final("streamed narration");
  }

  async *stream(input: GenerateInput): AsyncIterable<ModelStreamEvent> {
    const result = await this.generate(input);
    const toolCalls = result.message.toolCalls ?? [];
    for (const [index, call] of toolCalls.entries()) {
      yield {
        type: "tool_call_delta",
        index,
        id: call.id,
        name: call.name,
        argumentsDelta: JSON.stringify(call.arguments),
      };
    }
    for (let i = 0; i < result.message.content.length; i += 8) {
      yield { type: "text_delta", text: result.message.content.slice(i, i + 8) };
    }
    yield { type: "complete", result };
  }
}
