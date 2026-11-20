import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CHROME_THEME_BASE } from "../src/shared/chrome-theme-tokens.generated";
import { appThemePalette } from "../src/shared/app-theme-palette";
import { PermissionCardView } from "../src/renderer/src/components/PermissionCard";
import { QuestionCardBody } from "../src/renderer/src/components/QuestionCard";
import { initialCardState } from "../src/renderer/src/question-card";

const css = readFileSync("src/renderer/src/styles/app.css", "utf8");
type RGB = [number, number, number];
type Tokens = Record<string, string>;
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = css.match(new RegExp(`^${escaped} \\{([^}]+)\\}`, "m"))?.[1];
  if (!body) throw new Error(`Missing scoped rule: ${selector}`);
  return Object.fromEntries(body.split(";").filter((s) => s.trim()).map((s) => {
    const colon = s.indexOf(":");
    return [s.slice(0, colon).trim(), s.slice(colon + 1).trim()];
  }));
}
function mix(a: RGB, b: RGB, weight: number): RGB {
  return a.map((value, i) => value * weight + b[i]! * (1 - weight)) as RGB;
}
// Resolve the actual scoped CSS against generated baseline tokens, including
// encoded-sRGB mixing and the translucent hover tint over the card surface.
function color(value: string, tokens: Tokens, background?: RGB): RGB {
  const variable = value.match(/^var\(--([\w-]+)\)$/);
  if (variable) return color(tokens[variable[1]!]!, tokens, background);
  if (/^#[\da-f]{6}$/i.test(value)) return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as RGB;
  const mixed = value.match(/^color-mix\(in srgb, (var\(--[\w-]+\)) (\d+)%, (var\(--[\w-]+\))\)$/);
  if (mixed) return mix(color(mixed[1]!, tokens), color(mixed[3]!, tokens), Number(mixed[2]) / 100);
  const alpha = value.match(/^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/);
  if (alpha && background) return mix([Number(alpha[1]), Number(alpha[2]), Number(alpha[3])], background, Number(alpha[4]));
  throw new Error(`Unsupported test color: ${value}`);
}
function luminance(rgb: RGB): number {
  const linear = rgb.map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}
function contrast(a: RGB, b: RGB): number {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high! + 0.05) / (low! + 0.05);
}
const deny = ".permission-ask .actions .button.ghost.danger";

describe("baseline request-card accessibility", () => {
  it.each(["light", "dark"] as const)("keeps affected normal and hover labels at AA contrast in %s", (scheme) => {
    const tokens = CHROME_THEME_BASE[scheme];
    const card = color("var(--bg-elevated)", tokens);
    for (const selector of [".permission-agent", ".permission-ask .permission-guard", ".qc-note-toggle"]) {
      const foreground = rule(selector).color!;
      expect(foreground).toBe("var(--text-secondary)");
      expect(contrast(color(foreground, tokens), card)).toBeGreaterThanOrEqual(4.5);
    }
    const noteHover = rule(".qc-note-toggle:hover");
    expect(contrast(color(noteHover.color!, tokens), color(noteHover.background!, tokens))).toBeGreaterThanOrEqual(4.5);
    const denyInk = color(rule(deny).color!, tokens);
    expect(contrast(denyInk, card)).toBeGreaterThanOrEqual(4.5);
    const denyHover = color(rule(deny + ":hover").background!, tokens, card);
    expect(contrast(denyInk, denyHover)).toBeGreaterThanOrEqual(4.5);
    // Still danger-tinted, not a generic primary/secondary action.
    expect(denyInk[0]).toBeGreaterThan(denyInk[1]);
    expect(denyInk[0]).toBeGreaterThan(denyInk[2]);
  });

  it("changes only Deny's scoped ink, retaining the shared danger role and hover cue", () => {
    expect(rule(deny).color).toBe("color-mix(in srgb, var(--danger) 80%, var(--text))");
    expect(rule(deny + ":hover").background).toBe("var(--del-bg)");
    expect(rule(".button.danger").color).toBe("var(--danger)");
    expect(rule(".permission-guard.warn, .permission-ask .permission-guard.warn").color).toBe("var(--warning)");
  });

  it("keeps the request cards' readable roles baseline-owned under an authored root palette", () => {
    const palette = { light: { text: "#301f16", "text-secondary": "#614b3a", "bg-elevated": "#fff8ee" }, dark: { text: "#f9ecdd", "text-secondary": "#b9a088", "bg-elevated": "#211913" } };
    const respond = vi.fn();
    const permission = renderToStaticMarkup(<PermissionCardView request={{ requestId: "inert", threadId: "inert", toolName: "Run", summary: "fixture only", canAlwaysAllow: true }} guard="block" agentLabel="Fixture agent" onRespond={respond} />);
    const question = renderToStaticMarkup(QuestionCardBody({ request: { requestId: "inert", threadId: "inert", questions: [{ id: "q", header: "Format", question: "Which format?", options: [{ label: "Summary", description: "Brief" }], multiSelect: false, allowOther: false }] }, state: initialCardState, waiting: 0, dispatch: vi.fn(), onRespond: respond }));
    for (const scheme of ["light", "dark"] as const) {
      const authored = appThemePalette(palette, scheme);
      for (const role of ["text", "text-secondary", "bg-elevated"] as const) expect(authored[role]).not.toBe(CHROME_THEME_BASE[scheme][role]);
    }
    for (const html of [permission, question]) {
      for (const role of ["text", "text-secondary", "bg-elevated", "bg-hover", "focus"] as const) {
        expect(html).toContain(`--${role}:light-dark(${CHROME_THEME_BASE.light[role]}, ${CHROME_THEME_BASE.dark[role]})`);
      }
    }
    expect(permission).toContain('class="button ghost danger"');
    expect(permission).toContain("Deny");
    expect(permission).toContain("Always Allow");
    expect(permission).toContain("Allow Once");
    expect(question).toContain('role="listbox" aria-label="Which format?"');
    expect(respond).not.toHaveBeenCalled();
  });
});
