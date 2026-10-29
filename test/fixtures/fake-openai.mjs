// A fake OpenAI Responses API for tests. It calls
// mcp__cubiq.browser_eval whenever that namespace is offered and the turn
// hasn't called it yet, then answers with a message once the tool result comes
// back. Extracted from test/codex-e2e.test.ts so both the Codex e2e and the
// fixture's own test can drive it.
import { createServer } from "node:http";

export async function startFakeOpenAI(opts = {}) {
  const offered = [];
  const namespaces = [];
  const requests = [];
  const authHeaders = [];
  let n = 0;
  const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (opts.requireAuth && !req.headers.authorization) return void res.writeHead(401).end();
      if (!req.url?.endsWith("/responses")) return void res.writeHead(404).end();
      let request;
      try {
        request = JSON.parse(body);
      } catch {
        return void res.writeHead(400).end();
      }
      requests.push(request);
      authHeaders.push(req.headers.authorization ?? null);
      const ns = request.tools?.find((t) => t.name === "mcp__cubiq");
      offered.push(ns?.tools?.map((t) => t.name) ?? []);
      namespaces.push((request.tools ?? []).filter((t) => t.tools).map((t) => `${t.name}: ${t.tools.map((x) => x.name).join(",")}`));
      const id = `r${++n}`;
      const called = JSON.stringify(request.input).includes("function_call_output");
      const item =
        ns && !called
          ? { type: "function_call", call_id: `c${n}`, namespace: "mcp__cubiq", name: "browser_eval", arguments: '{"expression":"1+1"}' }
          : { type: "message", role: "assistant", id: `m${n}`, content: [{ type: "output_text", text: called ? "Evaluated." : "Hello." }] };
      const usage = { input_tokens: 10, input_tokens_details: null, output_tokens: 5, output_tokens_details: null, total_tokens: 15 };
      res.writeHead(200, {
        "content-type": "text/event-stream",
        // What the real backend sends for plan limits; Codex turns them into account/rateLimits/updated.
        "x-codex-primary-used-percent": "42",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "1790000000",
        "x-codex-secondary-used-percent": "9",
        "x-codex-secondary-window-minutes": "10080",
      });
      res.end(
        sse([
          { type: "response.created", response: { id } },
          { type: "response.output_item.done", item },
          { type: "response.completed", response: { id, usage } },
        ]),
      );
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1`, offered, namespaces, requests, authHeaders };
}
