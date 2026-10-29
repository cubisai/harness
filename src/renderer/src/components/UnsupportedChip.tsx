/** The amber chip for an agent the app reaches only unofficially. `compact` keeps the full text in the tooltip. */
export function UnsupportedChip({ note, compact }: { note: string; compact?: boolean }) {
  const text = `Unsupported · ${note}`;
  return (
    <span className="unsupported-chip" title={text}>
      {compact ? "Unsupported" : text}
    </span>
  );
}
