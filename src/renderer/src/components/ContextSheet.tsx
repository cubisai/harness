import { useEffect, useState } from "react";
import type { ContextPreview, StoredEvent, ThreadEvent } from "../../../shared/types";
import { api } from "../api";
import { useStore } from "../store";
import "../styles/context.css";

/** The label each guide source shows in the sheet. */
const GUIDE_LABELS: Record<ContextPreview["guide"][number]["source"], string> = {
  bundled: "Bundled guide",
  user: "Your guide",
  project: "Project .agents/HARNESS.md",
};

/**
 * The latest first-turn breakdown in a thread's events, or null when the thread
 * hasn't run yet. Pure, so the sheet's numbers are unit-testable.
 */
export function breakdownRows(events: StoredEvent[] | undefined): Extract<ThreadEvent, { kind: "context-breakdown" }> | null {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    const e = events![i]!.event;
    if (e.kind === "context-breakdown") return e;
  }
  return null;
}

/** What the total holds beyond the listed rows: the agent's own prompt, tools and messages. */
export function agentShare(e: Extract<ThreadEvent, { kind: "context-breakdown" }>): number {
  if (typeof e.total !== "number") return 0;
  return Math.max(0, e.total - e.rows.reduce((sum, r) => sum + r.tokens, 0));
}

/**
 * The Context sheet: what a thread has loaded into context, from the first-turn
 * breakdown and from the harness itself (guide, tools, MCP servers). Opened from
 * the composer's "/context". `preview` is a test seam for a static render; the
 * app passes nothing and the sheet fetches on open.
 */
export function ContextSheet({ preview: initial }: { preview?: ContextPreview | null } = {}) {
  const open = useStore((s) => s.contextSheetOpen);
  const threadId = useStore((s) => s.contextSheetThread);
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const close = useStore((s) => s.closeContextSheet);
  const events = useStore((s) => (threadId ? s.events[threadId] : undefined));
  const [fetched, setFetched] = useState<ContextPreview | null>(null);
  const [failed, setFailed] = useState(false);
  const preview = initial ?? fetched;
  const breakdown = breakdownRows(events);

  useEffect(() => {
    if (!open || initial !== undefined) return;
    setFailed(false);
    void api()
      .contextPreview(threadId, threadId ? null : selectedProjectId)
      .then(setFetched)
      .catch(() => {
        setFetched(null);
        setFailed(true);
      });
  }, [open, initial, threadId, selectedProjectId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  if (!open) return null;

  const toolsTotal = preview ? preview.tools.reduce((sum, t) => sum + t.tokens, 0) : 0;

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="sheet context-sheet" role="dialog" aria-modal="true" aria-label="Context">
        <h2>Context</h2>

        <section>
          <h3>First turn{breakdown?.estimated ? " (estimated)" : ""}</h3>
          {breakdown ? (
            <ul className="context-rows">
              {[...breakdown.rows]
                .sort((a, b) => b.tokens - a.tokens)
                .map((row) => (
                  <li key={row.label}>
                    <span className="context-label">{row.label}</span>
                    <span className="context-tokens">{row.tokens.toLocaleString()}</span>
                  </li>
                ))}
              {/* Estimated breakdowns only list the harness's share; the rest of the total is the agent's own. */}
              {breakdown.estimated && typeof breakdown.total === "number" && agentShare(breakdown) > 0 && (
                <li>
                  <span className="context-label">Agent's own prompt, tools and messages</span>
                  <span className="context-tokens">{agentShare(breakdown).toLocaleString()}</span>
                </li>
              )}
              {typeof breakdown.total === "number" && (
                <li className="context-total">
                  <span className="context-label">Total</span>
                  <span className="context-tokens">{breakdown.total.toLocaleString()}</span>
                </li>
              )}
            </ul>
          ) : (
            <p className="context-empty">Send a message to measure the first turn.</p>
          )}
        </section>

        <section>
          <h3>Added by CubiQ</h3>
          {!preview ? (
            <p className="context-empty">{failed ? "Couldn't read the context preview." : "Loading…"}</p>
          ) : (
            <>
              <h4>Guide</h4>
              {preview.guide.length > 0 ? (
                <ul className="context-rows">
                  {preview.guide.map((p) => (
                    <li key={p.path}>
                      <span className="context-label">{GUIDE_LABELS[p.source]}</span>
                      <span className="context-tokens">{p.tokens.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="context-empty">No guide</p>
              )}

              <h4>Harness tools</h4>
              {preview.tools.length > 0 ? (
                <ul className="context-rows">
                  {preview.tools.map((t) => (
                    <li key={t.name}>
                      <span className="context-label">{t.name}</span>
                      <span className="context-tokens">{t.tokens.toLocaleString()}</span>
                    </li>
                  ))}
                  <li className="context-total">
                    <span className="context-label">Total</span>
                    <span className="context-tokens">{toolsTotal.toLocaleString()}</span>
                  </li>
                </ul>
              ) : (
                <p className="context-empty">None</p>
              )}

              <h4>Skills</h4>
              {preview.skills === null ? (
                <p className="context-line">Open a thread to see its agent's skills</p>
              ) : preview.skills.mode === "none" ? (
                <p className="context-line">Not delivered to this agent</p>
              ) : (
                <p className="context-line">
                  {`${preview.skills.count} skills · ${preview.skills.tokens.toLocaleString()} tokens · ${
                    preview.skills.mode === "tool" ? "the skill tool plus the agent's own listing" : "listed by the agent itself"
                  }`}
                </p>
              )}

              <h4>MCP servers</h4>
              {preview.mcp.length > 0 ? (
                <ul className="context-rows">
                  {preview.mcp.map((s) => (
                    <li key={s.name} className={s.deferred ? "context-deferred" : undefined}>
                      <span className="context-label">{s.name}</span>
                      <span className="context-tokens">
                        {s.error ? `couldn't list: ${s.error}` : s.tokens === null ? "…" : `${s.tools} tools · ${s.tokens.toLocaleString()}${s.deferred ? " (deferred)" : ""}`}
                      </span>
                    </li>
                  ))}
                  <li className="context-total">
                    <span className="context-label">Total</span>
                    <span className="context-tokens">
                      {preview.mcp
                        .filter((s) => !s.deferred && s.tokens !== null)
                        .reduce((sum, s) => sum + (s.tokens ?? 0), 0)
                        .toLocaleString()}
                    </span>
                  </li>
                </ul>
              ) : (
                <p className="context-empty">None</p>
              )}

              <h4>Memory index</h4>
              <p className="context-line">
                {preview.memoryIndex ? `${preview.memoryIndex.lines.toLocaleString()} lines · ${preview.memoryIndex.tokens.toLocaleString()} tokens` : "Off"}
              </p>
            </>
          )}
        </section>

        <p className="context-footnote">Estimated at ~4 characters per token. The agent's own prompt and tools are only in the first-turn numbers. Deferred MCP schemas load only when the agent searches for a tool.</p>

        <div className="context-actions">
          <span className="spacer" />
          <button className="button primary" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
