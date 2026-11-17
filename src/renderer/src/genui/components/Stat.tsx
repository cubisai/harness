import { UiActions } from "../UiActions";
import type { StatSpec } from "../types";

/** Markdown for a stat block: an optional title, then one `label: value (delta)` line per tile. */
export function statMarkdown(spec: StatSpec): string {
  const lines = spec.stats.map((s) => `- ${s.label}: **${s.value}**${s.delta ? ` (${s.delta})` : ""}`).join("\n");
  return spec.title ? `**${spec.title}**\n\n${lines}` : lines;
}

/** Whether a delta reads as a rise or a fall, from its leading sign or arrow. */
function trend(delta: string): "up" | "down" | null {
  if (/^[+↑▲]/.test(delta)) return "up";
  if (/^[-−↓▼]/.test(delta)) return "down";
  return null;
}

/** Good or bad only when the block says which way is better: a rising churn or error rate isn't good news. */
export function verdict(delta: string, better: "up" | "down" | undefined): "good" | "bad" | null {
  const dir = trend(delta);
  if (!dir || !better) return null;
  return dir === better ? "good" : "bad";
}

/** One to four big-number tiles in a row. */
export function Stat({ spec }: { spec: StatSpec }) {
  return (
    <>
      {spec.title ? <div className="ui-title">{spec.title}</div> : null}
      <div className="ui-stats">
        {spec.stats.map((s, i) => {
          const judged = s.delta ? verdict(s.delta, s.better) : null;
          return (
            <div key={i} className="ui-stat">
              <div className="ui-stat-label">{s.label}</div>
              <div className="ui-stat-value">{s.value}</div>
              {s.delta ? <div className={`ui-stat-delta${judged ? ` ${judged}` : ""}`}>{s.delta}</div> : null}
            </div>
          );
        })}
      </div>
      <UiActions markdown={statMarkdown(spec)} />
    </>
  );
}
