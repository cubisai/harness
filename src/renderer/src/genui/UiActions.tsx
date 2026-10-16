import { useState } from "react";
import { useStore } from "../store";

/**
 * Actions under a UI block: copy it as Markdown, or drop that Markdown in the
 * message box (via `setComposerDraft`) so the user can edit and send it. Neither
 * action sends anything or talks to the main process.
 */
export function UiActions({ markdown }: { markdown: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ui-actions">
      <button
        type="button"
        className="code-copy"
        onClick={() => {
          void navigator.clipboard?.writeText(markdown).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <button
        type="button"
        className="code-copy"
        title="Put this in the message box to edit"
        onClick={() => useStore.getState().setComposerDraft(markdown)}
      >
        Use in reply
      </button>
    </div>
  );
}
