import type { RuntimeErrorShape } from "./errors.js";

export type RuntimeEvent =
  | { type: "agent_start"; sessionId: string }
  | { type: "turn_start"; turn: number }
  | { type: "message_start"; role: "user" | "assistant" }
  | { type: "message_update"; delta: string }
  | { type: "message_end"; messageId: string }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string }
  | { type: "tool_execution_update"; toolCallId: string; partial: string }
  | { type: "tool_execution_end"; toolCallId: string; ok: boolean }
  | { type: "skill_activation"; name: string }
  | { type: "turn_end"; turn: number }
  | { type: "agent_end"; sessionId: string }
  | { type: "runtime_error"; error: RuntimeErrorShape };

type Listener = (event: RuntimeEvent) => void;

export class EventBus {
  readonly events: RuntimeEvent[] = [];
  private readonly listeners = new Set<Listener>();

  emit(event: RuntimeEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
