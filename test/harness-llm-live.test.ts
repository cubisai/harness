// Live tool-loop check against an explicitly configured endpoint and model.
// Requires CUBIQ_LIVE_TESTS=1 and the LIVE_* settings in .env.example.

import { describe, expect, it } from "vitest";
import type { Provider } from "../src/shared/types";
import { generate, routeFor, type LlmMessage, type LlmRequest } from "../src/main/harness/llm";
import { liveProvider } from "./live-provider";

const configured = liveProvider();
const key = process.env[configured.envVar] ?? "";
const provider: Provider = { id: "live", label: configured.label, wireProtocol: configured.protocol, baseURL: configured.baseURL, secret: { kind: "envRef", envVar: configured.envVar }, models: [] };

const ADD = { name: "add", description: "Add two integers and return the sum.", parameters: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"] } };

describe.skipIf(!configured.enabled)("harness LLM client, live on a custom endpoint", () => {
  for (const protocol of [configured.protocol]) {
    it(`runs a tool loop on ${protocol}`, { timeout: 180_000 }, async () => {
      const model = configured.model;
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
