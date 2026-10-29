import { useState } from "react";
import { UiActions } from "../UiActions";
import type { TimelineSpec } from "../types";

/** Markdown for a timeline: numbered "time — title: detail" steps, dropping empty parts. */
export function timelineMarkdown(spec: TimelineSpec): string {
  const lines = spec.steps
    .map((step, i) => {
      const time = step.time ? `${step.time} — ` : "";
      const detail = step.detail ? `: ${step.detail}` : "";
      return `${i + 1}. ${time}${step.title}${detail}`;
    })
    .join("\n");
  return spec.title ? `**${spec.title}**\n\n${lines}` : lines;
}

/** A timeline; a step with a detail expands on click, collapsed shows only its title. */
export function Timeline({ spec }: { spec: TimelineSpec }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      {spec.title ? <div className="ui-title">{spec.title}</div> : null}
      <ol className="ui-timeline">
        {spec.steps.map((step, i) => {
          const expanded = open === i;
          return (
            <li key={i}>
              {step.time ? <span className="ui-time">{step.time}</span> : null}
              <div className="ui-timeline-title">{step.title}</div>
              {step.detail ? (
                <>
                  <button type="button" className="ui-timeline-toggle" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : i)}>
                    {expanded ? "Hide detail" : "Details"}
                  </button>
                  {expanded ? <div className="ui-timeline-detail">{step.detail}</div> : null}
                </>
              ) : null}
            </li>
          );
        })}
      </ol>
      <UiActions markdown={timelineMarkdown(spec)} />
    </>
  );
}
