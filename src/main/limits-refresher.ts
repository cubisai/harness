import type { LimitsPatch, LimitsTracker } from "./agents/limits";

/** One agent the refresher may ask for limits. */
export interface LimitsReader {
  agent: string;
  readLimits?(): Promise<LimitsPatch | "unsupported" | null>;
}

export interface LimitsRefresherOptions {
  drivers: LimitsReader[];
  tracker: LimitsTracker;
  now?: () => number;
  /** Injectable timers for tests; default to the globals. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (handle: ReturnType<typeof setInterval>) => void;
}

const TTL_MS = 5 * 60_000;
const TICK_MS = 60_000;
/** At most one rollover-triggered check per agent per minute. */
const ROLLOVER_MIN_MS = 60_000;
const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;

interface AgentState {
  inFlight: Promise<void> | null;
  /** Next-attempt delay after a failure; 0 when healthy. */
  backoff: number;
  lastAttemptAt: number | null;
  /** The login has no plan limits: stop asking until reset(). */
  unsupported: boolean;
  rolloverCheckedAt: number;
}

/**
 * Reads plan limits on demand, the way t3code does: at launch, when a window
 * regains focus, and on a slow interval — but never more than the TTL allows.
 * Per agent it backs off after failures, stops for good once the login says
 * it has no plan limits, and asks early once when a window's reset passes.
 */
export class LimitsRefresher {
  private states = new Map<string, AgentState>();
  private active = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private now: () => number;
  private setTimer: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private clearTimer: (handle: ReturnType<typeof setInterval>) => void;

  constructor(private opts: LimitsRefresherOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearInterval(h));
  }

  /** Check every agent whose snapshot is stale (or whose window just rolled over). */
  async tick(): Promise<void> {
    if (!this.active) return;
    await Promise.all(this.opts.drivers.map((d) => this.check(d)));
  }

  /** The window regained focus: same as a tick. */
  onFocus(): Promise<void> {
    return this.tick();
  }

  start(): void {
    if (this.timer) return;
    this.timer = this.setTimer(() => void this.tick(), TICK_MS);
    (this.timer as { unref?(): void }).unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  /** No focused window: ticks do nothing until it comes back. */
  setActive(active: boolean): void {
    this.active = active;
  }

  /** Forget "unsupported" and any back-off for one agent (e.g. a new login). */
  reset(agent: string): void {
    this.states.delete(agent);
  }

  private stateFor(agent: string): AgentState {
    let s = this.states.get(agent);
    if (!s) {
      s = { inFlight: null, backoff: 0, lastAttemptAt: null, unsupported: false, rolloverCheckedAt: -Infinity };
      this.states.set(agent, s);
    }
    return s;
  }

  private check(driver: LimitsReader): Promise<void> {
    const st = this.stateFor(driver.agent);
    if (st.unsupported || !driver.readLimits) return Promise.resolve();
    if (st.inFlight) return st.inFlight;
    const now = this.now();
    if (st.lastAttemptAt !== null && now - st.lastAttemptAt < st.backoff) return Promise.resolve();
    const last = this.opts.tracker.lastChecked(driver.agent);
    if (last !== null && now - last < TTL_MS && !this.rollover(driver.agent, last, now, st)) return Promise.resolve();
    st.lastAttemptAt = now;
    st.inFlight = this.probe(driver).finally(() => {
      st.inFlight = null;
    });
    return st.inFlight;
  }

  /** True when a window's reset passed since the last snapshot, and we haven't already chased one this minute. */
  private rollover(agent: string, last: number, now: number, st: AgentState): boolean {
    if (now - st.rolloverCheckedAt < ROLLOVER_MIN_MS) return false;
    const snap = this.opts.tracker.all().find((l) => l.agent === agent);
    const rolled = snap?.windows.some((w) => w.resetsAt !== null && w.resetsAt <= now && w.resetsAt > last) ?? false;
    if (rolled) st.rolloverCheckedAt = now;
    return rolled;
  }

  private async probe(driver: LimitsReader): Promise<void> {
    const st = this.stateFor(driver.agent);
    try {
      const res = await driver.readLimits!();
      if (res === "unsupported") {
        st.unsupported = true;
        return;
      }
      // null = couldn't ask right now (no running process): not a failure.
      if (res === null) return;
      this.opts.tracker.update(driver.agent, res, this.now());
      st.backoff = 0;
    } catch {
      st.backoff = st.backoff ? Math.min(st.backoff * 2, BACKOFF_CAP_MS) : BACKOFF_BASE_MS;
    }
  }
}
