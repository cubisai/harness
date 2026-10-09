import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AntigravityOptIn } from "../src/renderer/src/components/SettingsSheet";
import { UnsupportedChip } from "../src/renderer/src/components/UnsupportedChip";
import { ANTIGRAVITY_ACK_VERSION } from "../src/shared/provider-rules";
import type { SettingsView } from "../src/shared/types";

const settings = (patch: Partial<SettingsView> = {}) =>
  ({ theme: "system", defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: true, editor: null, providers: [], providerCredential: {}, migratedProviders: [], secretsEncrypted: true, ...patch }) as SettingsView;

describe("Antigravity in the UI", () => {
  it("shows the exact amber chip text", () => {
    expect(renderToStaticMarkup(<UnsupportedChip note="Gemini-compatible endpoints only" />)).toContain("Unsupported · Gemini-compatible endpoints only");
    const compact = renderToStaticMarkup(<UnsupportedChip note="Gemini-compatible endpoints only" compact />);
    expect(compact).toContain(">Unsupported<");
    expect(compact).toContain('title="Unsupported · Gemini-compatible endpoints only"');
  });

  it("offers the switch only behind the acknowledgement, and says why", () => {
    const off = renderToStaticMarkup(<AntigravityOptIn settings={settings()} update={() => {}} />);
    expect(off).toContain("Terms of");
    expect(off).toContain('type="checkbox"');
    expect(off).toMatch(/<button[^>]*disabled=""[^>]*>Turn On Antigravity/);
    const on = renderToStaticMarkup(<AntigravityOptIn settings={settings({ antigravity: true, antigravityAck: { version: ANTIGRAVITY_ACK_VERSION, at: 0 } })} update={() => {}} />);
    expect(on).toContain("Turn Off");
    expect(on).not.toContain('type="checkbox"');
  });
});
