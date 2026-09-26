import { useEffect, useRef, useState } from "react";
import { reasoningChannel } from "../live";

/**
 * One reasoning disclosure: streamed text, or — when the model keeps its
 * reasoning encrypted — only the token count. Auto-opens while streaming the
 * newest item, until the user toggles it by hand.
 */
export function ReasoningBlock({ text, opaque, live, newest, tokens }: { text: string; opaque: boolean; live: boolean; newest: boolean; tokens: number | null }) {
  // A block with no text is treated as opaque only when it says it is.
  const channel = reasoningChannel({ opaque: opaque && !text });
  const [open, setOpen] = useState(live && newest);
  const userToggled = useRef(false);

  useEffect(() => {
    if (!userToggled.current) setOpen(live && newest);
  }, [live, newest]);

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
