import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LiveDelta } from "../src/shared/types";
import { appendDelta, emptyLive, flushPending, visibleItems } from "../src/renderer/src/live";
import { Markdown } from "../src/renderer/src/markdown";

/** Markup of one reply through the renderer under test. */
const render = (text: string, streaming = false): string => renderToStaticMarkup(<Markdown text={text} streaming={streaming} />);
/** One `ui:<name>` fence around a line-format or JSON body. */
const fence = (name: string, body: unknown): string => `\`\`\`ui:${name}\n${typeof body === "string" ? body : JSON.stringify(body)}\n\`\`\``;
/** One text-delta from an engine; every chunk of a reply reuses its item id. */
const delta = (text: string): LiveDelta => ({ kind: "text-delta", itemId: "a", text });

/** The loan calculator fence agents write (named result, ^ power). */
const calc = fence("calculator", "principal|Principal|200000|$\nrate|Annual rate|6|%\nyears|Years|30|years\n=monthly = principal*(rate/1200)/(1-(1+rate/1200)^(-years*12))");
const chart = fence("chart", "Q1|12\nQ2|-5\nQ3|8");

/** A Claude reply as text blocks split around tool calls: intro, calculator, outro + chart. */
const blocks = ["Here is the loan math:\n\n", calc, "\n\nAnd the quarters:\n\n" + chart];
/** The same reply once the app has joined the blocks. */
const reply = blocks.join("");

/** The reply cut into engine-sized text-delta chunks of 3-5 chars. */
const chunked = (text: string): string[] => {
  const out: string[] = [];
  for (let i = 0, k = 0; i < text.length; k++) {
    const size = [3, 5, 4][k % 3]!;
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
};

/** The one flushed text item after these chunks are fed as text-deltas through live.ts. */
const liveText = (chunks: string[]): string => {
  let state = emptyLive();
  for (const text of chunks) state = appendDelta(state, delta(text));
  return visibleItems(flushPending(state), "text")[0]?.text ?? "";
};

describe("ui blocks across engine text shapes", () => {
  it("renders blocks split across Claude text blocks around tool calls", () => {
    // The app joins a turn's text blocks with "\n\n" (turns.ts); engines may also hand them over glued.
    for (const joined of [blocks.join("\n\n"), blocks.join("")]) {
      const html = render(joined);
      expect(html).toContain('data-ui="calculator"');
      expect(html).toContain('data-ui="chart"');
      expect(html).toContain("1,199.1");
      expect(html).not.toContain('class="code-block"');
    }
    // Every streaming prefix renders without throwing, and a partly written fence never becomes code.
    for (let end = 0; end <= reply.length; end += 7) {
      const html = render(reply.slice(0, end), true);
      expect(html).not.toContain('class="code-block"');
    }
    // With a newline after the closing fence too, both blocks mount while streaming.
    const full = render(reply + "\n", true);
    expect(full).toContain('data-ui="calculator"');
    expect(full).toContain('data-ui="chart"');
    expect(full).not.toContain('class="code-block"');
  });

  it("mounts both blocks while streaming a reply that ends at its closing fence", () => {
    const full = render(reply, true);
    expect(full).toContain('data-ui="calculator"');
    expect(full).toContain('data-ui="chart"');
  });

  it("renders a reply accumulated from many small Codex text deltas", () => {
    const parts = chunked(reply);
    expect(parts.join("")).toBe(reply);
    const accumulated = liveText(parts);
    expect(accumulated).toBe(reply);
    const settled = render(accumulated);
    expect(settled).toContain('data-ui="calculator"');
    expect(settled).toContain('data-ui="chart"');
    expect(settled).not.toContain('class="code-block"');
    const streamed = render(accumulated, true);
    expect(streamed).toContain('data-ui="calculator"');
    expect(streamed).toContain('data-ui="chart"');
    // One big final delta (the whole item at once) renders identically to the accumulated one.
    expect(liveText([reply])).toBe(reply);
    expect(render(liveText([reply]))).toBe(settled);
    expect(render(liveText([reply]), true)).toBe(streamed);
  });

  it("renders a fence whose opener and closer are split across ACP chunks", () => {
    const chunks = ["Here is the loan math:\n\n", "``", "`ui:calc", "ulator\n", "principal|Principal|200000|$", "\n", "rate|Annual rate|6|%", "\n", "years|Years|30|years", "\n", "=monthly = principal*(rate/1200)/(1-(1+rate/1200)^(-years*12))", "\n``", "`"];
    const joined = chunks.join("");
    expect(joined).toBe("Here is the loan math:\n\n" + calc);
    expect(render(joined)).toContain('data-ui="calculator"');
    expect(render(joined)).toContain("1,199.1");
    expect(render(joined)).not.toContain('class="code-block"');
    const viaLive = liveText(chunks);
    expect(viaLive).toBe(joined);
    expect(render(viaLive)).toContain('data-ui="calculator"');
    expect(render(viaLive)).not.toContain('class="code-block"');
  });

  it("renders the same reply with CRLF line endings", () => {
    const html = render(reply.replace(/\n/g, "\r\n"));
    expect(html).toContain('data-ui="calculator"');
    expect(html).toContain('data-ui="chart"');
    expect(html).toContain("1,199.1");
    expect(html).not.toContain('class="code-block"');
  });
});
