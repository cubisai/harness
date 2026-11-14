// One plain model call for judges, through the same endpoint the native eval agent uses.

import { generate, routeFor } from "../../src/main/harness/llm";
import type { Provider } from "../../src/shared/types";
import { evalProvider } from "./provider";

/** A judge's `ask`: the preset's model (or `model`), no tools, a short answer. The key is read on first use. */
export function askFor(o: { provider?: string; model?: string } = {}): { model: string; ask: (prompt: string) => Promise<string> } {
  const preset = evalProvider(o.provider, o.model);
  const model = preset.model;
  const provider: Provider = {
    id: "eval-judge",
    label: "eval judge",
    wireProtocol: preset.protocol,
    baseURL: preset.baseURL,
    secret: { kind: "envRef", envVar: preset.envVar },
    models: [{ id: model, name: model, capabilities: { tools: false, vision: false, reasoning: false }, contextWindow: 200_000, maxOutput: 1_000 }],
  };
  return {
    model,
    ask: async (prompt) => {
      const key = process.env[preset.envVar] ?? "";
      if (!key) throw new Error(`${preset.envVar} is not set (run with bun --env-file=.env)`);
      const r = await generate(routeFor(provider, preset.protocol, model, key), { model, system: ["You grade an AI agent's work against a rubric. Answer only with the JSON asked for."], messages: [{ role: "user", content: [{ type: "text", text: prompt }] }], tools: [], maxTokens: 400 });
      return r.text;
    },
  };
}
