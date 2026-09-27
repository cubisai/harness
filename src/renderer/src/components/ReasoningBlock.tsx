import { useEffect, useRef, useState } from "react";
import { reasoningChannel } from "../live";

/**
 * One reasoning disclosure: streamed text, or — when the model keeps its
 * reasoning encrypted — only the token count. Text reasoning is open, while
 * it streams and after, and never collapses on its own; only the user closes
 * it. Encrypted reasoning has nothing to show, so it starts closed.
 */
export function ReasoningBlock({ text, opaque, live, tokens }: { text: string; opaque: boolean; live: boolean; newest?: boolean; tokens: number | null }) {
  // A block with no text is treated as opaque only when it says it is.
  const channel = reasoningChannel({ opaque: opaque && !text });
  const [open, setOpen] = useState(channel === "text");
  const userToggled = useRef(false);

  useEffect(() => {
    // Text arriving for a block that started empty opens it, unless the user already chose.
    if (!userToggled.current && channel === "text") setOpen(true);
  }, [channel]);

  const label =
    channel === "text"
      ? live
        ? "Thinking…"
        : "Thinking"
      : live
        ? tokens !== null
          ? `Thinking… · ${formatTokens(tokens)} tokens`
          : "Thinking…"
        : "Reasoning (encrypted)";

  return (
    <details
      className="thinking"
      open={open}
      onToggle={(e) => {
        if (e.currentTarget.open === open) return;
        userToggled.current = true;
        setOpen(e.currentTarget.open);
      }}
    >
      <summary>{label}</summary>
      {channel === "text" ? (
        <div className="body">{text}</div>
      ) : (
        <div className="body muted">The model&apos;s reasoning is encrypted; only its length is shown.</div>
      )}
    </details>
  );
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}
