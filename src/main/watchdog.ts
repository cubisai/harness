/**
 * A turn's no-progress watchdog. Any event or live delta from the agent counts
 * as progress; time spent waiting on the user (a permission, plan or question
 * card) doesn't count. After `noticeMs` of silence it calls `onNotice` once per
 * silence; after `stopMs` it calls `onStop` once, so a provider that hangs or
 * retries forever ends the turn instead of leaving it spinning.
 */

/** Silence before the "may be stuck" notice. */
export const STALL_NOTICE_MS = 3 * 60_000;
/** Silence before the turn is stopped. */
export const STALL_STOP_MS = 10 * 60_000;

export interface TurnWatchdog {
  /** The agent did something. */
  bump(): void;
  /** Run `wait` (a card the user answers) without counting its time as silence. */
  waitOn<T>(wait: Promise<T>): Promise<T>;
  dispose(): void;
}

export function createTurnWatchdog(opts: {
  onNotice(): void;
  onStop(): void;
  noticeMs?: number;
  stopMs?: number;
  tickMs?: number;
  now?: () => number;
}): TurnWatchdog {
  const now = opts.now ?? Date.now;
  const noticeMs = opts.noticeMs ?? STALL_NOTICE_MS;
  const stopMs = opts.stopMs ?? STALL_STOP_MS;
  let last = now();
  let waiting = 0;
  let noticed = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    if (waiting > 0) {
      last = now();
      return;
    }
    const idle = now() - last;
    if (idle >= stopMs) {
      stopped = true;
      opts.onStop();
    } else if (idle >= noticeMs && !noticed) {
      noticed = true;
      opts.onNotice();
    }
  }, opts.tickMs ?? 5_000);
  timer.unref?.();
  return {
    bump() {
      last = now();
      noticed = false;
    },
    waitOn(wait) {
      waiting++;
      const done = () => {
        waiting--;
        last = now();
      };
      wait.then(done, done);
      return wait;
    },
    dispose() {
      clearInterval(timer);
    },
  };
}
