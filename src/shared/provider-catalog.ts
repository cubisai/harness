// A catalog of known provider presets, shared by the renderer's "Add provider"
// editor. Pure: it imports only types, so the renderer bundle can use it.

import type { WireProtocol } from "./types";

/** A provider preset: prefills the "Add provider" editor. URLs checked 2026-09-30 against models.dev api.json or the provider's docs. */
export interface ProviderPreset {
  id: string;
  label: string;
  wireProtocol: WireProtocol;
  baseURL: string;
  /** The env var the provider's own docs use for the key; shown as a hint only. */
  keyVar?: string;
  docs: string;
  /** A local server that ignores the key. */
  local?: true;
  /** Other protocols the same base URL serves, besides `wireProtocol`. */
  alsoServes?: readonly WireProtocol[];
}

// anthropic-messages presets (MiniMax, DeepSeek /anthropic, Moonshot, Z.ai /api/anthropic) wait for a live Claude turn per endpoint (roadmap N5).
// TokenHarbor and PGS Grove serve chat, Messages and Responses on one /v1 base (probed 2026-10-07); chat is the default because it reaches every agent (Claude and Codex through the gateway).
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: "tokenharbor", label: "TokenHarbor", wireProtocol: "openai-chat", baseURL: "https://tokenharbor.ai/v1", keyVar: "TOKENHARBOR_API_KEY", docs: "https://tokenharbor.ai/docs", alsoServes: ["anthropic-messages", "openai-responses"] },
  { id: "pgsgrove", label: "PGS Grove", wireProtocol: "openai-chat", baseURL: "https://api.pgsgrove.com/v1", docs: "https://pgsgrove.com", alsoServes: ["anthropic-messages", "openai-responses"] },
  { id: "deepseek", label: "DeepSeek", wireProtocol: "openai-chat", baseURL: "https://api.deepseek.com", keyVar: "DEEPSEEK_API_KEY", docs: "https://api-docs.deepseek.com" },
  { id: "openrouter", label: "OpenRouter", wireProtocol: "openai-chat", baseURL: "https://openrouter.ai/api/v1", keyVar: "OPENROUTER_API_KEY", docs: "https://openrouter.ai/docs" },
  { id: "fireworks-ai", label: "Fireworks AI", wireProtocol: "openai-chat", baseURL: "https://api.fireworks.ai/inference/v1", keyVar: "FIREWORKS_API_KEY", docs: "https://docs.fireworks.ai" },
  { id: "moonshotai", label: "Moonshot AI (Kimi)", wireProtocol: "openai-chat", baseURL: "https://api.moonshot.ai/v1", keyVar: "MOONSHOT_API_KEY", docs: "https://platform.moonshot.ai/docs" },
  { id: "moonshotai-cn", label: "Moonshot AI (China)", wireProtocol: "openai-chat", baseURL: "https://api.moonshot.cn/v1", keyVar: "MOONSHOT_API_KEY", docs: "https://platform.moonshot.cn/docs" },
  { id: "zai", label: "Z.ai", wireProtocol: "openai-chat", baseURL: "https://api.z.ai/api/paas/v4", keyVar: "ZHIPU_API_KEY", docs: "https://docs.z.ai" },
  { id: "zhipuai", label: "Zhipu AI (China)", wireProtocol: "openai-chat", baseURL: "https://open.bigmodel.cn/api/paas/v4", keyVar: "ZHIPU_API_KEY", docs: "https://docs.bigmodel.cn" },
  { id: "alibaba", label: "Alibaba Cloud (DashScope)", wireProtocol: "openai-chat", baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", keyVar: "DASHSCOPE_API_KEY", docs: "https://www.alibabacloud.com/help/en/model-studio" },
  { id: "alibaba-cn", label: "Alibaba Cloud (China)", wireProtocol: "openai-chat", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", keyVar: "DASHSCOPE_API_KEY", docs: "https://help.aliyun.com/zh/model-studio" },
  { id: "nvidia", label: "NVIDIA NIM", wireProtocol: "openai-chat", baseURL: "https://integrate.api.nvidia.com/v1", keyVar: "NVIDIA_API_KEY", docs: "https://docs.api.nvidia.com" },
  { id: "requesty", label: "Requesty", wireProtocol: "openai-chat", baseURL: "https://router.requesty.ai/v1", keyVar: "REQUESTY_API_KEY", docs: "https://docs.requesty.ai" },
  { id: "groq", label: "Groq", wireProtocol: "openai-chat", baseURL: "https://api.groq.com/openai/v1", keyVar: "GROQ_API_KEY", docs: "https://console.groq.com/docs/openai" },
  { id: "togetherai", label: "Together AI", wireProtocol: "openai-chat", baseURL: "https://api.together.ai/v1", keyVar: "TOGETHER_API_KEY", docs: "https://docs.together.ai/docs/openai-api-compatibility" },
  { id: "mistral", label: "Mistral", wireProtocol: "openai-chat", baseURL: "https://api.mistral.ai/v1", keyVar: "MISTRAL_API_KEY", docs: "https://docs.mistral.ai/api/" },
  { id: "xai", label: "xAI", wireProtocol: "openai-chat", baseURL: "https://api.x.ai/v1", keyVar: "XAI_API_KEY", docs: "https://docs.x.ai" },
  { id: "cerebras", label: "Cerebras", wireProtocol: "openai-chat", baseURL: "https://api.cerebras.ai/v1", keyVar: "CEREBRAS_API_KEY", docs: "https://inference-docs.cerebras.ai/resources/openai" },
  { id: "deepinfra", label: "DeepInfra", wireProtocol: "openai-chat", baseURL: "https://api.deepinfra.com/v1/openai", keyVar: "DEEPINFRA_API_KEY", docs: "https://docs.deepinfra.com/chat/overview" },
  { id: "vercel", label: "Vercel AI Gateway", wireProtocol: "openai-chat", baseURL: "https://ai-gateway.vercel.sh/v1", keyVar: "AI_GATEWAY_API_KEY", docs: "https://vercel.com/docs/ai-gateway" },
  { id: "ollama", label: "Ollama (local)", wireProtocol: "openai-chat", baseURL: "http://127.0.0.1:11434/v1", docs: "https://docs.ollama.com/openai", local: true },
  { id: "lmstudio", label: "LM Studio (local)", wireProtocol: "openai-chat", baseURL: "http://127.0.0.1:1234/v1", docs: "https://lmstudio.ai/docs/app/api/endpoints/openai", local: true },
];

export function providerPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
