import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CredentialRows } from "../src/renderer/src/components/ProviderSheet";
import { AntigravityOptIn } from "../src/renderer/src/components/SettingsSheet";
import { UnsupportedChip } from "../src/renderer/src/components/UnsupportedChip";
import { ANTIGRAVITY_ACK_VERSION } from "../src/shared/provider-rules";
import type { ProviderView, SettingsView } from "../src/shared/types";

const settings = (patch: Partial<SettingsView> = {}) =>
  ({ theme: "system", defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: true, editor: null, providerInjection: {}, providers: [], providerCredential: {}, migratedProviders: [], secretsEncrypted: true, ...patch }) as SettingsView;

describe("Antigravity in the UI", () => {
  it("shows the exact amber chip text", () => {
    expect(renderToStaticMarkup(<UnsupportedChip note="Gemini-compatible endpoints only" />)).toContain("Unsupported · Gemini-compatible endpoints only");
    const compact = renderToStaticMarkup(<UnsupportedChip note="Gemini-compatible endpoints only" compact />);
    expect(compact).toContain(">Unsupported<");
    expect(compact).toContain('title="Unsupported · Gemini-compatible endpoints only"');
  });

  it("is never in the provider picker, on or off", () => {
    const provider = { id: "gw", label: "Gateway", wireProtocol: "openai-chat", baseURL: "https://gw.example.com", models: [], secretKind: "safeStorage", hasSecret: true } as ProviderView;
    // As the ACP driver describes it: providerEnvOnly, so no BYOK row.
    const agents = [{ id: "antigravity", label: "Antigravity", credentials: { byok: false, own: "config", injector: "acp" } as const, unsupported: "Gemini-compatible endpoints only" }];
    expect(renderToStaticMarkup(<CredentialRows agents={agents} providers={[provider]} credentials={{}} onChange={() => {}} />)).not.toContain("Antigravity");
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
