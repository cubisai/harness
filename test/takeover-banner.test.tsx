import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IDLE, type TakeOverState } from "../src/renderer/src/takeover";
import { TakeOverBanner } from "../src/renderer/src/components/TakeOverBanner";

const noop = () => {};
const props = (state: TakeOverState, picking = false) => ({ state, agentLabel: "Claude", picking, onStop: noop, onResume: noop, onWatch: noop });

describe("TakeOverBanner", () => {
  it("shows the take-over state with a resume button", () => {
    const html = renderToStaticMarkup(<TakeOverBanner {...props({ mode: "human-driving", paused: true, steps: 2, watch: false })} />);
    expect(html).toContain("You took over");
    expect(html).toContain("Resume");
  });

  it("doubles as the element picker's banner", () => {
    expect(renderToStaticMarkup(<TakeOverBanner {...props(IDLE, true)} />)).toContain("Pick an element");
  });

  it("renders nothing when idle", () => {
    expect(renderToStaticMarkup(<TakeOverBanner {...props(IDLE)} />)).toBe("");
  });
});
