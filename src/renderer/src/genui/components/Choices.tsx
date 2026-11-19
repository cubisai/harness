import { useState } from "react";
import { useStore } from "../../store";
import { useUiOrigin } from "../origin";
import { sendUiReply } from "../reply";
import type { ChoicesSpec } from "../types";

/** Longest option text drawn on a button; the tap still sends the whole option. */
const SHOWN_MAX = 300;

/**
 * Tap-to-reply buttons. A tap sends that option as the user's message in the
 * reply's own thread; the block then shows what was picked. Once any user
 * message follows the reply (read from the transcript), the block stays used,
 * so a remount never offers the same answer twice.
 */
export function Choices({ spec }: { spec: ChoicesSpec }) {
  const origin = useUiOrigin();
  const queued = useStore((s) => (origin ? s.outbox[origin.threadId] : undefined));
  const [local, setLocal] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const answered = origin?.answer ?? null;
  const fromQueue = queued?.find((m) => spec.options.includes(m.text))?.text ?? null;
  const picked = answered !== null ? (spec.options.includes(answered) ? answered : null) : (fromQueue ?? local);
  const used = answered !== null || picked !== null || sending;
  return (
    <>
      {spec.title ? <div className="ui-title">{spec.title}</div> : null}
      <div className="ui-choices" role="group" aria-label={spec.title ?? "Reply options"}>
        {spec.options.map((option) => (
          <button
            key={option}
            type="button"
            className={`ui-choice${picked === option ? " on" : ""}`}
            disabled={used}
            aria-pressed={picked === option}
            title={option.length > SHOWN_MAX ? option : undefined}
            onClick={async () => {
              if (used) return;
              setSending(true);
              const ok = await sendUiReply(option, origin?.threadId);
              setSending(false);
              if (ok) setLocal(option);
            }}
          >
            {option.length > SHOWN_MAX ? `${option.slice(0, SHOWN_MAX - 1)}…` : option}
          </button>
        ))}
      </div>
    </>
  );
}
