import { useEffect, useState } from "react";

/** Claude Code's spinner glyphs, cycled while a turn runs. */
export const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

const VERBS = ["Thinking", "Working", "Pondering", "Crafting", "Cooking", "Brewing", "Musing", "Tinkering", "Computing", "Noodling", "Forging", "Weaving"];

/** A verb that stays the same for a turn: picked from the turn's start time. */
export function verbFor(startedAt: number): string {
  return VERBS[Math.floor(startedAt / 1000) % VERBS.length]!;
}

/** "42s", "3m 04s". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function tokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

/**
 * The line under a running turn, in Claude Code's style: a cycling glyph, a
 * verb, how long it has run, the tokens it has produced so far, and how to stop.
 */
export function WaitingLine({ startedAt, outputTokens, now: fixedNow }: { startedAt: number; outputTokens: number | null; now?: number }) {
  const [now, setNow] = useState(() => fixedNow ?? Date.now());
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (fixedNow !== undefined) return;
    const spin = setInterval(() => setFrame((f) => (f + 1) % GLYPHS.length), 120);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(spin);
      clearInterval(clock);
    };
  }, [fixedNow]);

  const facts = [elapsed(now - startedAt), ...(outputTokens ? [`↓ ${tokens(outputTokens)} tokens`] : []), "esc to interrupt"];
  return (
    <div className="waiting-line" role="status" aria-live="polite">
      <span className="waiting-glyph" aria-hidden>
        {GLYPHS[frame]}
      </span>
      <span className="waiting-verb">{verbFor(startedAt)}…</span>
      <span className="waiting-facts">({facts.join(" · ")})</span>
    </div>
  );
}
