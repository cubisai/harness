import { describe, expect, it } from "vitest";
import { createSseParser } from "../src/main/gateway/chat-stream";

describe("createSseParser", () => {
  it("reassembles events and lines split across pushes", () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push("data: hel");
    parser.push("lo\n\ndata: wor");
    parser.push("ld\n\n");
    expect(events).toEqual(["hello", "world"]);
  });

  it("handles CRLF line endings", () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push("data: a\r\n\r\ndata: b\r\n\r\n");
    expect(events).toEqual(["a", "b"]);
  });

  it("ignores comment lines", () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push(": keep-alive\n\ndata: x\n\n");
    expect(events).toEqual(["x"]);
  });

  it("joins multi-line data with a newline", () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push("data: one\ndata: two\n\n");
    expect(events).toEqual(["one\ntwo"]);
  });

  it("passes [DONE] through unchanged", () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push("data: [DONE]\n\n");
    expect(events).toEqual(["[DONE]"]);
  });

  it("ignores event, id and retry fields", () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push("event: ping\nid: 5\nretry: 100\ndata: v\n\n");
    expect(events).toEqual(["v"]);
  });

  it("flushes a final event with no trailing blank line on end()", () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push("data: last");
    parser.end();
    expect(events).toEqual(["last"]);
  });

  it("does not re-emit an already terminated event on end()", () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push("data: a\n\n");
    parser.end();
    expect(events).toEqual(["a"]);
  });
});
