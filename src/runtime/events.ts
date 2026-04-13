import type { RunEvent } from "./trace.js";

type Listener = (event: RunEvent) => void;

export class EventBus {
  readonly events: RunEvent[] = [];
  private readonly listeners = new Set<Listener>();

  emit(event: RunEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Observers must not break trace capture.
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
