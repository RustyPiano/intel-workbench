import type { RunEvent } from "./trace.js";

type Listener = (event: RunEvent) => void;

export const DEFAULT_EVENT_BUS_CAPACITY = 2000;

export interface EventBusOptions {
  capacity?: number;
}

/**
 * In-memory event bus with a bounded ring buffer of recent events.
 *
 * Subscribers receive every emitted event (no buffering on subscribe). The
 * internal ring buffer is for callers that need to inspect the tail of the
 * stream (e.g. CLI / diagnostics) without unbounded memory growth.
 */
export class EventBus {
  private readonly capacity: number;
  private readonly buffer: (RunEvent | undefined)[];
  private writeIndex = 0;
  private size = 0;
  private readonly listeners = new Set<Listener>();

  constructor(options: EventBusOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_EVENT_BUS_CAPACITY;
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`EventBus capacity must be a positive integer (got ${capacity})`);
    }

    this.capacity = Math.floor(capacity);
    this.buffer = new Array<RunEvent | undefined>(this.capacity).fill(undefined);
  }

  emit(event: RunEvent): void {
    this.buffer[this.writeIndex] = event;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size += 1;
    }

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

  /**
   * Returns a snapshot of the buffered events in emission order (oldest →
   * newest). Up to `capacity` entries; older events are dropped FIFO.
   */
  getBufferedEvents(): RunEvent[] {
    const result: RunEvent[] = [];
    const start = this.size < this.capacity ? 0 : this.writeIndex;
    for (let i = 0; i < this.size; i += 1) {
      const slot = this.buffer[(start + i) % this.capacity];
      if (slot !== undefined) {
        result.push(slot);
      }
    }
    return result;
  }

  /**
   * Returns the current ring buffer capacity. Primarily exposed for tests
   * and diagnostics.
   */
  get bufferCapacity(): number {
    return this.capacity;
  }
}
