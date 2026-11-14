import { describe, expect, it } from "vitest";
import { evalProvider } from "../evals/lib/provider";
import { liveProvider } from "./live-provider";

const endpoint = { EVAL_BASE_URL: "https://api.example.com/v1", EVAL_MODEL: "sample-model" };

describe("evaluation provider configuration", () => {
  it("uses an explicit endpoint without account-specific defaults", () => {
    expect(evalProvider("custom", undefined, endpoint)).toEqual({ envVar: "EVAL_API_KEY", baseURL: endpoint.EVAL_BASE_URL, model: "sample-model", protocol: "openai-chat" });
    expect(() => evalProvider("custom", undefined, {})).toThrow("EVAL_BASE_URL");
    expect(() => evalProvider("custom", undefined, { EVAL_BASE_URL: endpoint.EVAL_BASE_URL })).toThrow("EVAL_MODEL");
  });

  it("supports model overrides and all supported protocols", () => {
    for (const protocol of ["openai-chat", "openai-responses", "anthropic-messages"]) {
      expect(evalProvider("custom", "override", { ...endpoint, EVAL_PROTOCOL: protocol })).toMatchObject({ model: "override", protocol });
    }
  });

  it("rejects unknown presets, protocols, and non-HTTP endpoints", () => {
    expect(() => evalProvider("unknown", undefined, endpoint)).toThrow("--provider must be custom");
    expect(() => evalProvider("custom", undefined, { ...endpoint, EVAL_PROTOCOL: "invalid" })).toThrow("EVAL_PROTOCOL");
    expect(() => evalProvider("custom", undefined, { ...endpoint, EVAL_BASE_URL: "file:///example" })).toThrow("HTTP or HTTPS");
  });
});

describe("live provider opt-in", () => {
  const config = { LIVE_BASE_URL: "https://api.example.com/v1", LIVE_MODEL: "sample-model", LIVE_API_KEY: "test-key" };

  it("never enables real-provider tests just because credentials exist", () => {
    expect(liveProvider(config).enabled).toBe(false);
    expect(liveProvider({ ...config, CUBIQ_LIVE_TESTS: "0" }).enabled).toBe(false);
    expect(liveProvider({ ...config, CUBIQ_LIVE_TESTS: "1" }).enabled).toBe(true);
  });

  it("requires all connection settings", () => {
    expect(liveProvider({ CUBIQ_LIVE_TESTS: "1" }).enabled).toBe(false);
    expect(liveProvider({ ...config, CUBIQ_LIVE_TESTS: "1", LIVE_MODEL: "" }).enabled).toBe(false);
    expect(liveProvider({ ...config, CUBIQ_LIVE_TESTS: "1", LIVE_BASE_URL: "" }).enabled).toBe(false);
    expect(liveProvider({ ...config, CUBIQ_LIVE_TESTS: "1", LIVE_API_KEY: "" }).enabled).toBe(false);
  });

  it("validates opted-in protocols and endpoints", () => {
    expect(() => liveProvider({ ...config, CUBIQ_LIVE_TESTS: "1", LIVE_PROTOCOL: "invalid" })).toThrow("LIVE_PROTOCOL");
    expect(() => liveProvider({ ...config, CUBIQ_LIVE_TESTS: "1", LIVE_BASE_URL: "file:///example" })).toThrow("HTTP or HTTPS");
  });
});
