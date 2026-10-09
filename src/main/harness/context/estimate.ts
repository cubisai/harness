// A cheap token estimate for the context window: characters divided by four,
// with flat charges for images and screenshots so they don't silently vanish
// from the budget. It only has to be close enough to decide what to prune, not
// to bill anyone.

import type { LlmMessage } from "../llm/types";

export const CHARS_PER_TOKEN = 4;

/** Flat cost for any image, since its real token count isn't in the text. */
const IMAGE_TOKENS = 1000;

export function estimateText(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessage(m: LlmMessage): number {
  if (m.role === "user") {
    let n = 0;
    for (const p of m.content) n += p.type === "text" ? estimateText(p.text) : IMAGE_TOKENS;
    return n;
  }
  if (m.role === "assistant") {
    let n = 0;
    for (const p of m.content) {
      if (p.type === "text" || p.type === "reasoning") n += estimateText(p.text);
      else n += estimateText(p.name + (p.invalidInput ?? JSON.stringify(p.input)));
    }
    return n;
  }
  let n = 0;
  for (const r of m.results) n += estimateText(r.name + r.text) + (r.imagePng ? IMAGE_TOKENS : 0);
  return n;
}

export function estimateMessages(ms: LlmMessage[]): number {
  let n = 0;
  for (const m of ms) n += estimateMessage(m);
  return n;
}
