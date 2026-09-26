import type { TakeOverState } from "../takeover";

/**
 * Who holds the browser pane's pointer. Persistent, not a toast: the user can
 * walk away and come back to the same banner. The picker borrows it too.
 */
export function TakeOverBanner(props: {
  state: TakeOverState;
  agentLabel: string;
  picking: boolean;
  onStop(): void;
  onResume(): void;
  onWatch(on: boolean): void;
}) {
  const { state, agentLabel, picking, onStop, onResume, onWatch } = props;
  if (picking) {
    return (
      <div className="takeover-banner picking" role="status">
        Pick an element in the page · Esc cancels
      </div>
    );
  }
  if (state.mode === "agent-driving") {
    return (
      <div className="takeover-banner agent" role="status">
        <span className="takeover-dot" /> {agentLabel} is driving the browser · step {state.steps}
        <span className="grow" />
        <label>
          <input type="checkbox" checked={state.watch} onChange={(e) => onWatch(e.target.checked)} /> Watch only
        </label>
        <button className="button" onClick={onStop}>
          Stop
        </button>
      </div>
    );
  }
  if (state.mode === "human-driving") {
    return (
      <div className="takeover-banner human" role="status">
        You took over — {agentLabel} is paused
        <span className="grow" />
        <button className="button primary" onClick={onResume}>
          Resume
        </button>
        <button className="button" onClick={onStop}>
          Stop
        </button>
      </div>
    );
  }
  return null;
}
