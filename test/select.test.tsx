import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { nextEnabled, popupPlacement, Select, type SelectOption } from "../src/renderer/src/components/Select";

const options: SelectOption<string>[] = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta", disabled: true },
  { value: "c", label: "Gamma" },
];

describe("Select", () => {
  it("renders a listbox button showing the current label", () => {
    const html = renderToStaticMarkup(<Select value="c" options={options} onChange={() => {}} ariaLabel="Pick one" />);
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Pick one"');
    expect(html).toContain("Gamma");
    expect(html).not.toContain("<select");
  });

  it("steps over disabled options and wraps", () => {
    expect(nextEnabled(options, 0, 1)).toBe(2);
    expect(nextEnabled(options, 2, 1)).toBe(0);
    expect(nextEnabled(options, 0, -1)).toBe(2);
    expect(nextEnabled([{ value: "x", label: "X", disabled: true }], 0, 1)).toBe(-1);
  });

  it("opens below the button, or above when there's no room below", () => {
    const button = { top: 100, bottom: 126, left: 40, width: 120 };
    expect(popupPlacement(button, 200, 800)).toMatchObject({ top: 130, left: 40, minWidth: 120, above: false });
    const low = { top: 700, bottom: 726, left: 40, width: 120 };
    expect(popupPlacement(low, 200, 800)).toMatchObject({ top: 496, above: true });
  });
});
