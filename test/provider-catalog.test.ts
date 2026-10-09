import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS, providerPreset } from "../src/shared/provider-catalog";
import { isProviderId } from "../src/main/providers";

describe("PROVIDER_PRESETS", () => {
  it("has unique ids that are all valid provider ids", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(isProviderId(id), id).toBe(true);
  });

  it("has parseable base URLs with no trailing slash", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(new URL(preset.baseURL).href, preset.id).toBeTruthy();
      expect(preset.baseURL.endsWith("/"), preset.id).toBe(false);
    }
  });

  it("uses http and 127.0.0.1 only for local presets, https elsewhere", () => {
    for (const preset of PROVIDER_PRESETS) {
      const url = new URL(preset.baseURL);
      if (preset.local) {
        expect(url.protocol, preset.id).toBe("http:");
        expect(url.hostname, preset.id).toBe("127.0.0.1");
      } else {
        expect(url.protocol, preset.id).toBe("https:");
      }
    }
  });

  it("gives every non-local preset a documented key variable", () => {
    // PGS Grove's docs name no variable.
    for (const preset of PROVIDER_PRESETS.filter((p) => !p.local && p.id !== "pgsgrove")) {
      expect(preset.keyVar, preset.id).toBeDefined();
      expect(preset.keyVar, preset.id).toMatch(/^[A-Z][A-Z0-9_]*_KEY$/);
    }
  });

  it("provides a docs URL for every preset", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.docs, preset.id).toMatch(/^https:\/\//);
    }
  });

  it("lists only other, distinct protocols as also served", () => {
    for (const preset of PROVIDER_PRESETS.filter((p) => p.alsoServes)) {
      expect(preset.alsoServes, preset.id).not.toContain(preset.wireProtocol);
      expect(new Set(preset.alsoServes).size, preset.id).toBe(preset.alsoServes!.length);
    }
  });

  it("offers TokenHarbor and PGS Grove on chat, which every agent reaches", () => {
    for (const id of ["tokenharbor", "pgsgrove"]) {
      const preset = providerPreset(id)!;
      expect(preset.wireProtocol, id).toBe("openai-chat");
      expect(preset.baseURL.endsWith("/v1"), id).toBe(true);
      expect([...preset.alsoServes!].sort(), id).toEqual(["anthropic-messages", "openai-responses"]);
    }
  });
});

describe("providerPreset", () => {
  it("finds a preset by id", () => {
    expect(providerPreset("groq")?.baseURL).toBe("https://api.groq.com/openai/v1");
  });

  it("returns undefined for an unknown id", () => {
    expect(providerPreset("nope")).toBeUndefined();
  });
});
