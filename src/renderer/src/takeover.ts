export type DriveMode = "idle" | "agent-driving" | "human-driving";

export interface TakeOverState {
  mode: DriveMode;
  paused: boolean;
  steps: number;
  /** Watch mode: clicks and keys are seen but never take the pointer. */
  watch: boolean;
}

export const IDLE: TakeOverState = { mode: "idle", paused: false, steps: 0, watch: false };

export type TakeOverAction =
  | { type: "agent-action" }
  | { type: "human-input" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "turn-ended" }
  | { type: "watch"; on: boolean };

/** An exclusive lock: whoever holds the pointer keeps it until a transition the lock allows. Unknown or disallowed transitions return the same object. */
export function takeOverReducer(s: TakeOverState, a: TakeOverAction): TakeOverState {
  switch (a.type) {
    case "agent-action":
      if (s.mode === "idle") return { ...s, mode: "agent-driving", steps: 1 };
      if (s.mode === "agent-driving") return { ...s, steps: s.steps + 1 };
      return s; // the human holds the lock; the paused agent can't take it back
    case "human-input":
      if (s.mode === "agent-driving" && !s.watch) return { ...s, mode: "human-driving", paused: true };
      return s; // in watch mode pointer events never leave agent-driving; in idle there is nothing to take over
    case "resume":
      if (s.mode === "human-driving") return { ...s, mode: "agent-driving", paused: false };
      return s;
    case "stop":
    case "turn-ended":
      return { ...IDLE, watch: s.watch };
    case "watch":
      return { ...s, watch: a.on };
  }
}
