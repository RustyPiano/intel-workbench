import { afterEach, describe, expect, it, vi } from "vitest";

import { askInquiryStream, type ApiInquiryStreamEvent } from "../src/api";

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function splitUtf8Payload(payload: string): Uint8Array[] {
  const encoded = new TextEncoder().encode(payload);
  const firstSplit = payload.indexOf("研判") + 1;
  const splitAt = new TextEncoder().encode(payload.slice(0, firstSplit)).length;
  return [encoded.slice(0, splitAt), encoded.slice(splitAt, splitAt + 3), encoded.slice(splitAt + 3)];
}

describe("askInquiryStream", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses fragmented SSE frames with split UTF-8 and skips malformed frames", async () => {
    const inquiry = {
      id: "inq-1",
      ts: "2026-06-17T00:00:00Z",
      user: "analyst",
      question: "问题",
      status: "answered" as const,
      answer: "最终答案",
      claims: [],
    };
    const payload = [
      'data: {"type":"token","text":"开始研判"}\n\n',
      "data: not-json\n\n",
      `data: ${JSON.stringify({ type: "done", inquiry })}\n\n`,
      'data: {"type":"token","text":"不应显示"}\n\n',
    ].join("");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(streamFromChunks(splitUtf8Payload(payload)), {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        }),
      ),
    );

    const events: ApiInquiryStreamEvent[] = [];
    await askInquiryStream("case-1", "问题", (event) => events.push(event));

    expect(events).toEqual([{ type: "token", text: "开始研判" }, { type: "done", inquiry }]);
  });

  it("throws JSON message for pre-stream non-SSE errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          { message: "text LLM not configured" },
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const onEvent = vi.fn();

    await expect(askInquiryStream("case-1", "问题", onEvent)).rejects.toThrow("text LLM not configured");
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("returns quietly when the request is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError")));

    await expect(askInquiryStream("case-1", "问题", vi.fn(), controller.signal)).resolves.toBeUndefined();
  });
});
