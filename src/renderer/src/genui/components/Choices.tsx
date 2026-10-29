import { useState } from "react";
import { sendUiReply } from "../reply";
import type { ChoicesSpec } from "../types";

/** Tap-to-reply buttons. A tap sends that option as the user's message; the block then shows what was picked. */
export function Choices({ spec }: { spec: ChoicesSpec }) {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <>
      {spec.title ? <div className="ui-title">{spec.title}</div> : null}
      <div className="ui-choices" role="group" aria-label={spec.title ?? "Reply options"}>
        {spec.options.map((option, i) => (
          <button
            key={i}
            type="button"
            className={`ui-choice${picked === option ? " on" : ""}`}
            disabled={picked !== null}
            aria-pressed={picked === option}
            onClick={() => {
              if (sendUiReply(option)) setPicked(option);
            }}
          >
            {option}
          </button>
        ))}
      </div>
    </>
  );
}
