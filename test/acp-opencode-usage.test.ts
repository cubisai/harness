import { describe, expect, it } from "vitest";
import { exportTurnUsage, runForStdout, sumExportUsage, type TurnTokens } from "../src/main/agents/acp/opencode-usage";

function msg(role: string, created: number, tokens?: Record<string, unknown>): unknown {
  return { info: { role, time: { created }, tokens }, parts: [] };
}

const since = 1760500000000;

describe("sumExportUsage", () => {
  it("sums two assistant messages after sinceMs across all token fields", () => {
    const stdout = JSON.stringify({
      info: {},
      messages: [
        msg("user", since),
        msg("assistant", since + 1, { input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 0 } }),
        msg("assistant", since + 2, { input: 20, output: 3, reasoning: 4, cache: { read: 6, write: 2 } }),
      ],
    });
    const out = sumExportUsage(stdout, since)!;
    expect(out).toEqual({ input: 30, output: 5, reasoning: 5, cacheRead: 11, cacheWrite: 2 });
  });

  it("ignores user messages and assistant messages created before sinceMs", () => {
    const stdout = JSON.stringify({
      messages: [
        msg("assistant", since - 1, { input: 99, output: 99, cache: { read: 99, write: 99 } }),
        msg("user", since + 1, { input: 99, output: 99, cache: { read: 99, write: 99 } }),
        msg("assistant", since + 1, { input: 7, output: 1, cache: { read: 2, write: 3 } }),
      ],
    });
    const out = sumExportUsage(stdout, since)!;
    expect(out).toEqual({ input: 7, output: 1, reasoning: 0, cacheRead: 2, cacheWrite: 3 });
  });

  it("tolerates leading log text before the first {", () => {
    const stdout = `some log line\nanother\n` + JSON.stringify({
      messages: [msg("assistant", since + 1, { input: 5, output: 1 })],
    });
    const out = sumExportUsage(stdout, since)!;
    expect(out.input).toBe(5);
    expect(out.output).toBe(1);
  });

  it("returns null for garbage, for missing messages, and when no assistant message matches", () => {
    expect(sumExportUsage("not json at all", since)).toBeNull();
    expect(sumExportUsage(JSON.stringify({ info: {} }), since)).toBeNull();
    const noMatch = JSON.stringify({ messages: [msg("user", since + 1), msg("assistant", since - 1)] });
    expect(sumExportUsage(noMatch, since)).toBeNull();
  });

  it("reads OpenCode v2's flat export (`session export --standalone`, 2.1.0), matching the turn's ACP prompt usage", () => {
    // Trimmed from a real 2.1.0 export: session totals (title generation included) sit on `info`, never summed.
    const v2 = (type: string, created: number, tokens?: Record<string, unknown>) => ({ id: `msg_${created}`, time: { created }, type, ...(tokens ? { tokens, finish: "stop" } : {}) });
    const stdout = JSON.stringify({
      info: { id: "ses_x", tokens: { input: 8218, output: 193, reasoning: 256, cache: { read: 22528, write: 0 } }, time: { created: since } },
      messages: [
        v2("model-switched", since + 1),
        v2("user", since + 2),
        v2("assistant", since + 3, { input: 3654, output: 52, reasoning: 139, cache: { read: 6144, write: 0 } }),
        v2("system", since + 4),
        v2("assistant", since + 5, { input: 245, output: 106, reasoning: 19, cache: { read: 9856, write: 0 } }),
        v2("assistant", since + 6, { input: 4127, output: 24, reasoning: 0, cache: { read: 6144, write: 0 } }),
        v2("idle", since + 7),
      ],
    });
    // ACP prompt usage for the same turn: inputTokens 8026, outputTokens 182, thoughtTokens 158, cachedReadTokens 22144.
    expect(sumExportUsage(stdout, since)).toEqual({ input: 8026, output: 182, reasoning: 158, cacheRead: 22144, cacheWrite: 0 });
    expect(sumExportUsage(stdout, since + 6)).toEqual({ input: 4127, output: 24, reasoning: 0, cacheRead: 6144, cacheWrite: 0 });
  });

  it("counts missing numeric fields as zero", () => {
    const stdout = JSON.stringify({ messages: [msg("assistant", since + 1)] });
    expect(sumExportUsage(stdout, since)).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("runForStdout", () => {
  it("resolves stdout text on a zero exit", async () => {
    expect(await runForStdout(process.execPath, ["-e", "process.stdout.write('ok')"], process.env, 5000)).toBe("ok");
  });

  it("resolves null on a non-zero exit", async () => {
    expect(await runForStdout(process.execPath, ["-e", "process.exit(3)"], process.env, 5000)).toBeNull();
  });

  it("keeps output past 64 KB from a process that exits right after writing", async () => {
    const out = await runForStdout(process.execPath, ["-e", "process.stdout.write('x'.repeat(300000)); process.exit(0)"], process.env, 5000);
    expect(out?.length).toBe(300000);
  });

  it("resolves null on timeout, in under 3s", async () => {
    const t0 = Date.now();
    const out = await runForStdout(process.execPath, ["-e", "setTimeout(()=>{}, 10000)"], process.env, 300);
    expect(out).toBeNull();
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("exportTurnUsage", () => {
  it("calls run with ['export', sessionId] and sums the fake export", async () => {
    let got: { command: string; args: string[]; env?: NodeJS.ProcessEnv; timeoutMs: number } | null = null;
    const fake = async (command: string, args: string[], env: NodeJS.ProcessEnv | undefined, timeoutMs: number): Promise<string | null> => {
      got = { command, args, env, timeoutMs };
      return JSON.stringify({ messages: [msg("assistant", since + 1, { input: 3, output: 2, cache: { read: 1, write: 1 } })] });
    };
    const out = await exportTurnUsage({ command: "opencode", env: {}, sessionId: "ses_x", sinceMs: since, timeoutMs: 1234, run: fake });
    expect(got).toEqual({ command: "opencode", args: ["export", "ses_x"], env: {}, timeoutMs: 1234 });
    expect(out).toEqual({ input: 3, output: 2, reasoning: 0, cacheRead: 1, cacheWrite: 1 });
  });

  it("returns null when run returns null", async () => {
    const fake = async (): Promise<string | null> => null;
    expect(await exportTurnUsage({ command: "opencode", sessionId: "ses_x", sinceMs: since, run: fake })).toBeNull();
  });
});
