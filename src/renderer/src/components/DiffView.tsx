import { Fragment } from "react";
import { parseUnifiedDiff } from "../../../shared/diff";
import type { ToolDiff } from "../../../shared/tools";

/** The one renderer for every agent's file edits: parsed unified diffs, text only. */
export function DiffView({ diffs }: { diffs: ToolDiff[] }) {
  return (
    <>
      {diffs.map((d, i) =>
        parseUnifiedDiff(d.unified).map((f, j) => (
          <div className="tool-diff" key={`${i}-${j}`}>
            <div className="tool-diff-path">
              {d.path} <span className="stat">+{f.additions} −{f.deletions}</span>
            </div>
            {f.hunks.map((h, k) => (
              <Fragment key={k}>
                <div className="hunk-header">{h.header}</div>
                {h.lines.map((l, m) => (
                  <div key={m} className={`line ${l.kind}`}>
                    {l.text}
                  </div>
                ))}
              </Fragment>
            ))}
          </div>
        )),
      )}
    </>
  );
}

/** A payload's canonical diffs when it carries them, else null. */
export function diffsOf(payload: unknown): ToolDiff[] | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const diff = (payload as { diff?: unknown }).diff;
  if (!Array.isArray(diff)) return null;
  return diff.every((d) => Boolean(d) && typeof d === "object" && typeof (d as ToolDiff).path === "string" && typeof (d as ToolDiff).unified === "string")
    ? (diff as ToolDiff[])
    : null;
}
