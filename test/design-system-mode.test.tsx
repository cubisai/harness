import { describe, expect, it } from "vitest";
import { colorRoles, foundationGroups, foundationOf, ramp, resolveVars, schemeValues, siblingUrl, tokenMatches } from "../src/renderer/src/design/system-mode";

const t = (name: string, light: string, dark: string | null = null) => ({ name, light, dark });

describe("System mode's foundations", () => {
  it("puts each token on one page, and a component's own non-colour token on none", () => {
    expect(foundationOf(t("--color-primary", "#123456"))).toBe("colors");
    expect(foundationOf(t("--text-md", "16px"))).toBe("typography");
    expect(foundationOf(t("--space-4", "16px"))).toBe("spacing");
    expect(foundationOf(t("--radius-md", "8px"))).toBe("shape");
    expect(foundationOf(t("--shadow-md", "0 1px 2px #0003"))).toBe("elevation");
    expect(foundationOf(t("--content-max", "1200px"))).toBe("breakpoints");
    expect(foundationOf(t("--duration-fast", "120ms"))).toBe("motion");
    expect(foundationOf(t("--btn-fill", "oklch(0.5 0.1 200)"))).toBe("colors");
    expect(foundationOf(t("--btn-pad", "12px"))).toBeNull();
    const groups = foundationGroups([t("--color-a", "#000"), t("--text-sm", "12px"), t("--color-b", "#fff")]);
    expect(groups.colors.map((x) => x.name)).toEqual(["--color-a", "--color-b"]);
  });
  it("reads a scheme, dark falling back to light, and resolves var() with fallbacks", () => {
    const values = schemeValues([t("--a", "#111", "#eee"), t("--b", "var(--a)"), t("--c", "color-mix(in srgb, var(--b) 50%, var(--nope, red))")], "dark");
    expect(values["--b"]).toBe("var(--a)");
    expect(resolveVars(values["--c"]!, values)).toBe("color-mix(in srgb, #eee 50%, red)");
    expect(resolveVars("var(--loop)", { "--loop": "var(--loop)" })).toBe("var(--loop)");
  });
  it("draws a role from the kit's own state tokens, working out the ones it lacks", () => {
    const roles = colorRoles({ "--color-primary": "#0f968a", "--color-primary-hover": "#0c7a70", "--color-on-primary": "#fff", "--color-danger": "red", "--color-danger-soft": "pink" });
    expect(roles.map((r) => r.label)).toEqual(["Primary", "Error"]);
    const [primary, error] = roles;
    expect(primary!.fill.map((s) => s.token)).toEqual(["--color-primary", "--color-primary-hover", null]);
    expect(primary!.fill[2]!.value).toContain("#0f968a");
    expect(primary!.fill[0]!.ink).toBe("#fff");
    expect(error!.container[0]).toMatchObject({ token: "--color-danger-soft", value: "pink" });
  });
  it("ramps ten steps with the colour itself at 500", () => {
    const steps = ramp("#0f968a");
    expect(steps).toHaveLength(10);
    expect(steps[5]).toBe("#0f968a");
  });
  it("searches names and values", () => {
    expect(tokenMatches(t("--color-primary", "#0F968A"), "968a")).toBe(true);
    expect(tokenMatches(t("--color-primary", "#0F968A"), "danger")).toBe(false);
  });
  it("serves a sample beside the page", () => {
    expect(siblingUrl("cubiq-design://d/t1/pages/a%20b.html", "pages/a b.html", ".preview-part.html")).toBe("cubiq-design://d/t1/.preview-part.html");
    expect(siblingUrl("cubiq-design://d/t1/index.html?v=2", "index.html", ".preview-part.html")).toBe("cubiq-design://d/t1/.preview-part.html");
  });
});
