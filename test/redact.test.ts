import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/main/inject/redact";

const TOKEN = "test-key-value-1";

describe("redactSecrets", () => {
  it("replaces a secret with the redaction marker", () => {
    const out = redactSecrets(`auth failed for ${TOKEN}`, [TOKEN]);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("«redacted»");
  });

  it("replaces every occurrence", () => {
    const out = redactSecrets(`${TOKEN} and again ${TOKEN}`, [TOKEN]);
    expect(out).not.toContain(TOKEN);
    expect(out.match(/«redacted»/g)).toHaveLength(2);
  });

  it("ignores empty and too-short secrets", () => {
    expect(redactSecrets("abc xyz", ["", "ab"])).toBe("abc xyz");
  });
});
