// Live check of the harness LLM client against TokenHarbor, one tool loop per
// protocol. Skipped unless TOKENHARBOR_API_KEY is set in the environment (the
// key is never stored); TH_CHAT_MODEL / TH_RESPONSES_MODEL / TH_MESSAGES_MODEL
// override the models picked from the listing.

import { describe, expect, it } from "vitest";
import type { Provider } from "../src/shared/types";
import { generate, routeFor, type HarnessProtocol, type LlmMessage, type LlmRequest } from "../src/main/harness/llm";

const key = process.env.TOKENHARBOR_API_KEY ?? "";
const BASE = "https://tokenharbor.ai/v1";
const provider: Provider = { id: "tokenharbor", label: "TokenHarbor", wireProtocol: "openai-chat", baseURL: BASE, secret: { kind: "envRef", envVar: "TOKENHARBOR_API_KEY" }, models: [] };

async function listModels(): Promise<string[]> {
  const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
  const json = (await res.json()) as { data?: { id: string }[] };
  return (json.data ?? []).map((m) => m.id);
}

function pick(ids: string[], protocol: HarnessProtocol): string | undefined {
  const env = { "openai-chat": process.env.TH_CHAT_MODEL, "openai-responses": process.env.TH_RESPONSES_MODEL, "anthropic-messages": process.env.TH_MESSAGES_MODEL }[protocol];
  if (env) return env;
  // Cheap models first: a plan may not include the bigger ones.
  if (protocol === "anthropic-messages") return ids.find((id) => /claude-haiku/i.test(id)) ?? ids.find((id) => /claude/i.test(id));
  if (protocol === "openai-responses") return ids.find((id) => /^(openai\/)?gpt-5/i.test(id)) ?? ids.find((id) => /gpt/i.test(id));
  return ids.find((id) => /deepseek.*flash$/i.test(id)) ?? ids.find((id) => /deepseek|qwen|glm/i.test(id)) ?? ids[0];
}

const ADD = { name: "add", description: "Add two integers and return the sum.", parameters: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"] } };

describe.skipIf(!key)("harness LLM client, live on TokenHarbor", () => {
  for (const protocol of ["openai-chat", "openai-responses", "anthropic-messages"] as const) {
    it(`runs a tool loop on ${protocol}`, { timeout: 180_000 }, async () => {
      const model = pick(await listModels(), protocol);
      expect(model, `no model for ${protocol}`).toBeTruthy();
      const route = routeFor(provider, protocol, model!, key);
      const messages: LlmMessage[] = [{ role: "user", content: [{ type: "text", text: "Use the add tool to add 2 and 3, then tell me the result in one short sentence." }] }];
      const req = (): LlmRequest => ({ model: model!, system: ["You are a terse assistant. Always use tools for arithmetic."], messages, tools: [ADD], maxTokens: 4096, reasoning: true, effort: "low", cacheKey: "harness-live" });

      const first = await generate(route, req());
      const call = first.message.find((p) => p.type === "tool-call");
      console.log(`[${protocol}] ${model}: ${first.reason}, usage ${JSON.stringify(first.usage)}`);
      expect(first.reason).toBe("tool-calls");
      expect(call).toMatchObject({ name: "add", input: { a: 2, b: 3 } });

      messages.push({ role: "assistant", content: first.message }, { role: "tool", results: [{ callId: (call as { id: string }).id, name: "add", text: "5" }] });
      const second = await generate(route, req());
      console.log(`[${protocol}] answer: ${second.text}`);
      expect(second.reason).toBe("stop");
      expect(second.text).toMatch(/5|five/i);
    });
  }
});
