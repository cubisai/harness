import { useState } from "react";
import { nextDue, validSchedule } from "../../../shared/automation-schedule";
import type { AutomationInput } from "../../../shared/automations";

export function SchedulePreview({ schedule, missed, enabled, anchor }: Pick<AutomationInput, "schedule" | "missed" | "enabled"> & { anchor?: number }) {
  const [now] = useState(Date.now);
  const error = validSchedule(schedule);
  if (error) return <p className="form-error" role="alert">{error}</p>;
  const zone = schedule.kind === "daily" ? schedule.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const format = new Intl.DateTimeFormat(undefined, { timeZone: zone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "shortOffset" });
  const times: number[] = [];
  for (let i = 0; i < 3; i++) times.push(nextDue(schedule, times.at(-1) ?? now, anchor ?? now));
  return <div className="note">
    <strong>{enabled ? "Next three times" : "If enabled"}</strong>
    {schedule.kind === "interval" && anchor === undefined && " · If saved now"}
    {` · ${schedule.kind === "interval" ? "Display zone: " : ""}${zone}`}
    <ol>{times.map((t) => <li key={t}><time dateTime={new Date(t).toISOString()}>{format.format(t)}</time></li>)}</ol>
    {missed === "coalesce" ? "Catch-up runs the latest missed occurrence once." : "Skip drops a missed occurrence more than one minute late."}
  </div>;
}
