import { describe, expect, it } from "vitest";
import { classifyOpenCodeLog, parseLogfmt } from "../src/main/agents/acp/opencode-log";

// Real lines OpenCode writes to stderr with `--print-logs --log-level INFO`.
const ASKING = `timestamp=2026-10-14T04:04:39.232Z level=INFO run=916d64b6 message=asking id=per_138956cc0001Mnc1dt0ox059vY permission=external_directory patterns="[\\"/tmp/*\\"]"`;
const STREAM = `timestamp=2026-10-14T04:20:13.408Z level=ERROR run=916d64b6 message="stream error" providerID=agentrouter modelID=deepseek-v4-flash session.id=ses_ec778c03fffepjzNXEi8PBiTUy small=false agent=orchestrator mode=primary error.error="AI_APICallError: sensitive words detected (request id: 20261014122012647370121gtvv5DOGFxpRF)"`;

describe("parseLogfmt", () => {
  it("parses bare and quoted key=value pairs", () => {
    expect(parseLogfmt(ASKING)).toEqual({
      timestamp: "2026-10-14T04:04:39.232Z",
      level: "INFO",
      run: "916d64b6",
      message: "asking",
      id: "per_138956cc0001Mnc1dt0ox059vY",
      permission: "external_directory",
      patterns: `["/tmp/*"]`,
    });
  });

  it("unescapes a \\\" inside a quoted value", () => {
    expect(parseLogfmt('a="he said \\"hi\\"" b=2')).toEqual({ a: 'he said "hi"', b: "2" });
  });

  it("returns null for a non-logfmt line", () => {
    expect(parseLogfmt("not json: agents sometimes log to stdout")).toBeNull();
    // A URL with an "=" but no key of its own is still not logfmt.
    expect(parseLogfmt("Open the following link to authenticate: https://example.com/sign-in?x=1")).toBeNull();
  });

  it("returns null for a 'creating instance' line", () => {
    expect(parseLogfmt("creating instance")).toBeNull();
  });
});

describe("classifyOpenCodeLog", () => {
  it("classifies an asking line, parsing its patterns JSON", () => {
    expect(classifyOpenCodeLog(ASKING)).toEqual({
      kind: "asking",
      id: "per_138956cc0001Mnc1dt0ox059vY",
      permission: "external_directory",
      patterns: ["/tmp/*"],
    });
  });

  it("classifies a stream error, stripping the request id", () => {
    expect(classifyOpenCodeLog(STREAM)).toEqual({
      kind: "stream-error",
      provider: "agentrouter",
      model: "deepseek-v4-flash",
      error: "AI_APICallError: sensitive words detected",
    });
  });

  it("falls back to no patterns when the patterns value isn't a JSON array", () => {
    expect(classifyOpenCodeLog(`message=asking id=per_x permission=read patterns="not json"`)).toEqual({
      kind: "asking",
      id: "per_x",
      permission: "read",
      patterns: [],
    });
  });

  it("returns null for anything else", () => {
    expect(classifyOpenCodeLog("creating instance")).toBeNull();
    expect(classifyOpenCodeLog("message=starting server")).toBeNull();
    // A stream error without error.error is not classified.
    expect(classifyOpenCodeLog(`message="stream error" providerID=p`)).toBeNull();
  });
});

describe("meaningfulStderr", () => {
  it("drops routine and cut-off logfmt lines, keeps an ERROR line's error text once, and passes plain lines through", async () => {
    const { meaningfulStderr } = await import("../src/main/agents/rpc");
    const tail = [
      'timestamp=2026-10-14T06:28:01.000Z level=INFO run=e314d76a message=stream providerID=opencode-go modelID=mimo-v2.6-flash',
      'timestamp=2026-10-14T06:28:02.000Z level=ERROR run=e314d76a message="stream error" error.error="AI_APICallError: Upstream request failed"',
      'timestamp=2026-10-14T06:28:03.000Z level=ERROR run=e314d76a message="stream error" error.error="AI_APICallError: Upstream request failed"',
      "Error: missing API key",
      'timestamp=2026-10-14T06:28:05.980Z level=INFO run=e314d76a message=cancel session.id=ses_x',
      '3effezlB8uRyxsRi2xx small=false agent=orchestrator',
    ].join("\n");
    expect(meaningfulStderr(tail)).toEqual(["AI_APICallError: Upstream request failed", "Error: missing API key"]);
  });
});
