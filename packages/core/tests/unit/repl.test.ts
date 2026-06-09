import { beforeEach, describe, expect, test, vi } from "vitest";

const question = vi.fn(async () => "exit");
const close = vi.fn();

vi.mock("node:readline/promises", () => ({
  default: {
    createInterface: vi.fn(() => ({
      question,
      close,
    })),
  },
}));

describe("startRepl", () => {
  beforeEach(() => {
    question.mockClear();
    close.mockClear();
  });

  test("does not subscribe to the event bus because the caller owns timeline rendering", async () => {
    const subscribe = vi.fn(() => () => {});
    const createConversation = vi.fn(async () => ({
      send: vi.fn(),
    }));

    const { startRepl } = await import("../../src/cli/repl.js");

    await startRepl({
      agent: {
        eventBus: {
          subscribe,
        },
        createConversation,
      } as never,
      traceMode: "compact",
    });

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(subscribe).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
