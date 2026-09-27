import { useEffect, useRef, useState } from "react";
import { commonPrefix, nextReveal } from "../smooth";

const reduceMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The part of a streaming `text` to show now: it grows toward the full text
 * one animation frame at a time (see smooth.ts). With reduced motion, or once
 * the stream stops (`streaming` false), it is simply the whole text.
 */
export function useSmoothText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(() => (streaming && !reduceMotion() ? 0 : text.length));
  const shownRef = useRef(shown);
  const last = useRef(text);

  // A rewritten stream (not an append) resumes from what still matches.
  if (last.current !== text && !text.startsWith(last.current)) {
    shownRef.current = Math.min(shownRef.current, commonPrefix(last.current, text));
  }
  last.current = text;

  useEffect(() => {
    if (!streaming || reduceMotion()) {
      shownRef.current = text.length;
      setShown(text.length);
      return;
    }
    let frame = 0;
    let prev = performance.now();
    const tick = (now: number) => {
      const next = nextReveal(shownRef.current, text.length, now - prev);
      prev = now;
      if (next !== shownRef.current) {
        shownRef.current = next;
        setShown(next);
      }
      if (next < text.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, streaming]);

  return text.slice(0, Math.min(shown, text.length));
}
