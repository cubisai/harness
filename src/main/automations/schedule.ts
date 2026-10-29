import type { MissedPolicy, Schedule } from "../../shared/automations";

const MINUTE_MS = 60_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Formatters are cached per zone: building one is not free and we call this a lot. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    FORMATTERS.set(timeZone, f);
  }
  return f;
}

/** The wall-clock fields of an epoch instant in a zone (0=Sun..6=Sat). */
export function zonedParts(ms: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const parts = formatter(timeZone).formatToParts(ms);
  const num = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: num("year"),
    month: num("month"),
    day: num("day"),
    hour: num("hour") % 24, // some engines render midnight as "24" under h23
    minute: num("minute"),
    weekday: Math.max(0, WEEKDAYS.indexOf((parts.find((p) => p.type === "weekday")?.value ?? "") as (typeof WEEKDAYS)[number])),
  };
}

/** The wall clock at an instant, expressed as epoch ms as if that clock were UTC. */
function wallMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
}

/**
 * The epoch ms of a wall time in a zone. A spring-forward gap (a wall time that
 * doesn't exist) resolves to the first valid minute after it; a fall-back
 * ambiguity resolves to the FIRST of the two occurrences.
 */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Guess with the offset at the instant that reads the same clock, then correct once with the offset at that guess.
  const first = wall - (wallMs(wall, timeZone) - wall);
  let t = wall - (wallMs(first, timeZone) - first);
  if (wallMs(t, timeZone) === wall) return t;
  // Landed before the target: we are in a gap, so walk to the first valid minute after it.
  if (wallMs(t, timeZone) < wall) {
    for (let i = 0; i < 1440 && wallMs(t, timeZone) < wall; i++) t += MINUTE_MS;
  } else {
    for (let i = 0; i < 1440 && wallMs(t, timeZone) > wall; i++) t -= MINUTE_MS;
  }
  return t;
}

/** Null when the schedule is well-formed, else the reason it is not. */
export function validSchedule(s: Schedule): string | null {
  if (s.kind === "interval") {
    if (!Number.isInteger(s.everyMinutes) || s.everyMinutes < 1 || s.everyMinutes > 10080) {
      return "everyMinutes must be an integer between 1 and 10080";
    }
    return null;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.at)) return "at must be HH:MM (24-hour)";
  if (s.days !== undefined) {
    if (s.days.length === 0) return "days must not be empty";
    if (s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return "days must be weekdays 0..6";
    if (new Set(s.days).size !== s.days.length) return "days must not repeat";
  }
  if (!validTimeZone(s.timeZone)) return "timeZone must be a valid IANA zone";
  return null;
}

function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function atParts(at: string): { hour: number; minute: number } {
  const [h = "0", m = "0"] = at.split(":");
  return { hour: Number(h), minute: Number(m) };
}

/** The first scheduled instant strictly after `afterMs`. */
export function nextDue(s: Schedule, afterMs: number, anchorMs = 0): number {
  if (s.kind === "interval") {
    const period = s.everyMinutes * MINUTE_MS;
    return anchorMs + (Math.floor((afterMs - anchorMs) / period) + 1) * period;
  }
  const { hour, minute } = atParts(s.at);
  const start = zonedParts(afterMs, s.timeZone);
  for (let i = 0; i < 8; i++) {
    const d = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    if (s.days && !s.days.includes(d.getUTCDay())) continue;
    const t = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, minute, s.timeZone);
    if (t > afterMs) return t;
  }
  throw new Error("no due time within 8 days");
}

/**
 * The scheduled instants in (lastScheduledMs, nowMs], folded by the missed
 * policy. A brand-new automation (null last) first runs at nextDue, not now.
 */
export function dueTimes(s: Schedule, lastScheduledMs: number | null, nowMs: number, policy: MissedPolicy, anchorMs = 0): number[] {
  if (lastScheduledMs === null) return [];
  const hits: number[] = [];
  let cursor = lastScheduledMs;
  for (let i = 0; i < 10000; i++) {
    const t = nextDue(s, cursor, anchorMs);
    if (t > nowMs) break;
    hits.push(t);
    cursor = t;
  }
  if (hits.length === 0) return [];
  const last = hits[hits.length - 1]!;
  if (policy === "coalesce") return [last];
  return nowMs - last <= MINUTE_MS ? [last] : [];
}

/** The identity of one scheduled run: same automation and instant, same key. */
export function runKey(automationId: string, scheduledMs: number): string {
  return `${automationId}@${new Date(scheduledMs).toISOString()}`;
}

/** A human phrase for a schedule, e.g. "Mon, Wed, Fri at 09:00 (Europe/London)". */
export function describeSchedule(s: Schedule): string {
  if (s.kind === "interval") {
    return s.everyMinutes % 60 === 0 && s.everyMinutes >= 60 ? `every ${s.everyMinutes / 60} h` : `every ${s.everyMinutes} min`;
  }
  const days = s.days?.slice().sort((a, b) => a - b).map((d) => WEEKDAYS[d] ?? "");
  return `${days ? `${days.join(", ")} at ${s.at}` : `daily at ${s.at}`} (${s.timeZone})`;
}
