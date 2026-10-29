// Claude's injector. All provider-injection logic was removed when providers
// became native agents; what remains is the live security rule: the variables
// Claude reads its endpoint and key from, stripped from every plan so a
// provider key exported in the shell never reaches an agent.

/** The variables Claude reads its endpoint and key from; stripped from every plan before injection. */
export const CLAUDE_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];
