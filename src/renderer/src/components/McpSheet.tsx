import { useEffect } from "react";
import { useStore } from "../store";
import { McpPanel } from "./McpPanel";

/** The /mcp sheet: the same servers panel as Library › Connectors, over the thread. */
export function McpSheet() {
  const open = useStore((s) => s.mcpSheetOpen);
  const prefill = useStore((s) => s.mcpSheetPrefill);
  const close = useStore((s) => s.closeMcpSheet);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="sheet mcp-sheet" role="dialog" aria-modal="true" aria-label="MCP servers">
        <div className="sheet-head">
          <h2>MCP servers</h2>
          <button className="button ghost" onClick={close}>
            Done
          </button>
        </div>
        <McpPanel prefill={prefill} compact />
      </div>
    </div>
  );
}
