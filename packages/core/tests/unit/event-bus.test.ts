import { describe, expect, test } from "vitest";

import { DEFAULT_EVENT_BUS_CAPACITY, EventBus } from "../../src/runtime/events.js";
import type { RunEvent, RunPhase } from "../../src/runtime/trace.js";

function makeEvent(seq: number, overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    schema_version: "v1.2",
    event_id: `evt_${seq}`,
    trace_id: "trace_test",
    run_id: "run_test",
    seq,
    ts: `2026-05-18T00:00:00.${String(seq).padStart(3, "0")}Z`,
    type: "test_event",
    phase: "system" satisfies RunPhase,
    level: "info",
    summary: `event ${seq}`,
    ...overrides,
  };
}

describe("EventBus ring buffer", () => {
  test("default capacity drops oldest events FIFO when overflowing", () => {
    const bus = new EventBus();
    expect(bus.bufferCapacity).toBe(DEFAULT_EVENT_BUS_CAPACITY);

    const total = 5000;
    for (let seq = 1; seq <= total; seq += 1) {
      bus.emit(makeEvent(seq));
    }

    const buffered = bus.getBufferedEvents();
    expect(buffered).toHaveLength(2000);

    // Should retain the *latest* 2000 events, in monotonic seq order.
    expect(buffered[0]?.seq).toBe(total - 2000 + 1);
    expect(buffered.at(-1)?.seq).toBe(total);
    for (let i = 1; i < buffered.length; i += 1) {
      expect(buffered[i]!.seq).toBe(buffered[i - 1]!.seq + 1);
    }
  });

  test("subscribers receive every emitted event regardless of buffer size", () => {
    const bus = new EventBus({ capacity: 8 });
    const observed: number[] = [];
    bus.subscribe((event) => observed.push(event.seq));

    const total = 5000;
    for (let seq = 1; seq <= total; seq += 1) {
      bus.emit(makeEvent(seq));
    }

    expect(observed).toHaveLength(total);
    expect(observed[0]).toBe(1);
    expect(observed.at(-1)).toBe(total);
    // Buffer is still bounded by capacity.
    expect(bus.getBufferedEvents()).toHaveLength(8);
  });

  test("capacity can be overridden via constructor", () => {
    const bus = new EventBus({ capacity: 3 });
    expect(bus.bufferCapacity).toBe(3);

    bus.emit(makeEvent(1));
    bus.emit(makeEvent(2));
    bus.emit(makeEvent(3));
    bus.emit(makeEvent(4));

    const buffered = bus.getBufferedEvents();
    expect(buffered.map((event) => event.seq)).toEqual([2, 3, 4]);
  });

  test("returns a defensive snapshot in emission order", () => {
    const bus = new EventBus({ capacity: 4 });
    bus.emit(makeEvent(1));
    bus.emit(makeEvent(2));

    const snapshot = bus.getBufferedEvents();
    expect(snapshot.map((event) => event.seq)).toEqual([1, 2]);

    // Mutating the returned array does not affect future snapshots.
    snapshot.push(makeEvent(99));
    expect(bus.getBufferedEvents().map((event) => event.seq)).toEqual([1, 2]);
  });

  test("rejects non-positive capacity", () => {
    expect(() => new EventBus({ capacity: 0 })).toThrow();
    expect(() => new EventBus({ capacity: -1 })).toThrow();
    expect(() => new EventBus({ capacity: Number.NaN })).toThrow();
  });

  test("subscriber errors do not break trace capture", () => {
    const bus = new EventBus({ capacity: 10 });
    bus.subscribe(() => {
      throw new Error("observer fault");
    });

    expect(() => bus.emit(makeEvent(1))).not.toThrow();
    expect(bus.getBufferedEvents().map((event) => event.seq)).toEqual([1]);
  });
});
