import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeOpenAI, type FakeOpenAI } from "./fixtures/fake-openai.mjs";

const auth = { Authorization: "Bearer test" };

describe("fake-openai fixture", () => {
  let fake: FakeOpenAI;
  beforeAll(async () => {
    fake = await startFakeOpenAI({ requireAuth: true });
  });
  afterAll(() => void fake.server.close());

  const post = (url: string, body: string, headers: Record<string, string> = auth) =>
    fetch(`${url}/responses`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  it("401s without an Authorization header", async () => {
    const res = await post(fake.url, "{}", {});
    expect(res.status).toBe(401);
  });

  it("400s on a malformed JSON body", async () => {
    const res = await post(fake.url, "not json");
    expect(res.status).toBe(400);
  });

  it("404s on any path that isn't /responses", async () => {
    const res = await fetch(`${fake.url}/chat`, { method: "POST", headers: auth });
    expect(res.status).toBe(404);
  });

  it("calls browser_eval when offered, then answers once the result comes back", async () => {
    const tools = [{ name: "mcp__cubiq", tools: [{ name: "browser_eval" }] }];
    const first = await (await post(fake.url, JSON.stringify({ tools, input: [] }))).text();
    expect(first).toContain('"type":"function_call"');
    expect(first).toContain('"name":"browser_eval"');
    expect(fake.offered.at(-1)).toEqual(["browser_eval"]);

    const second = await (await post(fake.url, JSON.stringify({ tools, input: [{ type: "function_call_output" }] }))).text();
    expect(second).toContain('"type":"message"');
    expect(second).toContain("Evaluated.");
  });
});
