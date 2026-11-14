import type { HarnessProtocol } from "../../src/main/harness/llm/types";

/** Explicit, environment-configured endpoint for optional evaluations. */
export function evalProvider(name = "custom", model?: string, env: NodeJS.ProcessEnv = process.env): { envVar: string; baseURL: string; protocol: HarnessProtocol; model: string } {
  if (name !== "custom") throw new Error("--provider must be custom; configure EVAL_BASE_URL, EVAL_MODEL, EVAL_PROTOCOL, and EVAL_API_KEY");
  const baseURL = env.EVAL_BASE_URL?.trim();
  const selectedModel = model?.trim() || env.EVAL_MODEL?.trim();
  const protocol = env.EVAL_PROTOCOL ?? "openai-chat";
  if (!baseURL) throw new Error("EVAL_BASE_URL is not set; configure your own endpoint in .env");
  if (!selectedModel) throw new Error("EVAL_MODEL is not set; configure a model in .env or pass --model");
  if (!["openai-chat", "openai-responses", "anthropic-messages"].includes(protocol)) throw new Error("EVAL_PROTOCOL must be openai-chat, openai-responses, or anthropic-messages");
  const url = new URL(baseURL);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("EVAL_BASE_URL must use HTTP or HTTPS");
  return { envVar: "EVAL_API_KEY", baseURL, protocol: protocol as HarnessProtocol, model: selectedModel };
}
