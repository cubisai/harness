import { describe, expect, it } from "vitest";
import { displayOrder } from "../src/renderer/src/event-order";

const ev = (kind: string, seq: number) => ({ seq, event: { kind } });
const kinds = (events: ReturnType<typeof ev>[]) => events.map((e) => e.event.kind);

describe("displayOrder", () => {
  it("moves the notices after a user event above it", () => {
    const events = [ev("user", 1), ev("notice", 2), ev("notice", 3), ev("turn-start", 4), ev("text", 5)];
    expect(kinds(displayOrder(events))).toEqual(["notice", "notice", "user", "turn-start", "text"]);
  });

  it("leaves a notice after turn-start where it is", () => {
    const events = [ev("user", 1), ev("turn-start", 2), ev("notice", 3)];
    expect(kinds(displayOrder(events))).toEqual(["user", "turn-start", "notice"]);
  });

  it("leaves a notice before any user event alone", () => {
    const events = [ev("notice", 1), ev("user", 2)];
    expect(kinds(displayOrder(events))).toEqual(["notice", "user"]);
  });

  it("handles each turn's notice independently", () => {
    const events = [
      ev("user", 1),
      ev("notice", 2),
      ev("turn-start", 3),
      ev("text", 4),
      ev("user", 5),
      ev("notice", 6),
      ev("turn-start", 7),
      ev("text", 8),
    ];
    expect(kinds(displayOrder(events))).toEqual([
      "notice",
      "user",
      "turn-start",
      "text",
      "notice",
      "user",
      "turn-start",
      "text",
    ]);
  });

  it("returns an empty list unchanged", () => {
    expect(displayOrder([])).toEqual([]);
  });
});
