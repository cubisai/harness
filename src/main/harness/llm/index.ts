// The harness's LLM client: one request/event language over OpenAI chat,
// OpenAI Responses and Anthropic Messages.

export * from "./types";
export { PROTOCOLS, generate, httpError, routeFor, streamLlm, type LlmResult, type Route, type StreamOptions } from "./client";
export { adaptiveThinking } from "./protocols/anthropic-messages";
