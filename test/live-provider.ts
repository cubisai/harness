import type { HarnessProtocol } from "../src/main/harness/llm/types";

/** Real-provider tests require explicit opt-in; normal checks never use local account defaults. */
export function liveProvider(env: NodeJS.ProcessEnv = process.env): { label: string; envVar: string; baseURL: string; protocol: HarnessProtocol; model: string; enabled: boolean } {
  const baseURL = env.LIVE_BASE_URL?.trim() ?? "";
  const model = env.LIVE_MODEL?.trim() ?? "";
  const protocol = env.LIVE_PROTOCOL ?? "openai-chat";
  const enabled = env.CUBIQ_LIVE_TESTS === "1" && Boolean(env.LIVE_API_KEY && baseURL && model);
  if (enabled && !["openai-chat", "openai-responses", "anthropic-messages"].includes(protocol)) throw new Error("LIVE_PROTOCOL must be openai-chat, openai-responses, or anthropic-messages");
  if (enabled && !["http:", "https:"].includes(new URL(baseURL).protocol)) throw new Error("LIVE_BASE_URL must use HTTP or HTTPS");
  return { label: `custom (${protocol})`, envVar: "LIVE_API_KEY", baseURL, protocol: protocol as HarnessProtocol, model, enabled };
}
