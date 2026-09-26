// The env var name a provider's key is passed in, shared by the injectors that
// hand the key to a spawned agent process instead of writing it to a file.

import type { Provider } from "../../shared/types";
import { LEGACY_ENV, type LegacyProviderId } from "../providers";

/** The env var a provider's key is passed in. */
export function providerKeyVar(providerId: string): string {
  return `UNSKILLED_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`;
}

/**
 * The conventional env var a provider's key is passed in: a migrated legacy id
 * keeps its documented name, otherwise the wire protocol's usual variable.
 */
export function protocolKeyVar(provider: Provider): string | null {
  if (provider.id in LEGACY_ENV) return LEGACY_ENV[provider.id as LegacyProviderId];
  switch (provider.wireProtocol) {
    case "anthropic-messages":
      return "ANTHROPIC_API_KEY";
    case "openai-chat":
    case "openai-responses":
      return "OPENAI_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
  }
  return null;
}
