// Pure provider rules shared by the main process and the renderer. They import
// no Node built-ins, so the renderer bundle can use them directly.

import type { Provider } from "./types";

/**
 * Feature-loss text when Claude is pointed at a non-first-party host: a custom
 * ANTHROPIC_BASE_URL disables Remote Control and MCP tool search by default.
 * An unparseable URL is treated as non-first-party.
 */
export function providerWarning(provider: Pick<Provider, "baseURL">, injector: string): string | null {
  if (injector !== "claude") return null;
  let host: string | null = null;
  try {
    host = new URL(provider.baseURL).hostname;
  } catch {
    host = null;
  }
  if (host === "api.anthropic.com") return null;
  return "A non-first-party ANTHROPIC_BASE_URL disables Remote Control and MCP tool search by default. Use api.anthropic.com to keep them, or accept the loss.";
}

/**
 * The Antigravity disclosure's version. Bumping it (when the text changes in
 * substance) turns the opt-in off until the user acknowledges the new text.
 */
export const ANTIGRAVITY_ACK_VERSION = 1;

/**
 * Codex 0.157+ rejects `wire_api = "chat"` and supports only Responses-API
 * providers, so a chat-completions provider cannot drive it (spike S2,
 * spec/open-questions.md).
 */
export function codexCompatible(provider: Pick<Provider, "wireProtocol">): { ok: true } | { ok: false; reason: string } {
  if (provider.wireProtocol === "openai-responses") return { ok: true };
  return {
    ok: false,
    reason: `Codex 0.157+ rejects wire_api = "chat" and supports only Responses-API providers; this provider speaks ${provider.wireProtocol} (spike S2, spec/open-questions.md).`,
  };
}
