// The endpoint OpenCode's CubiQ plugin asks before an edit or a command
// (OpenCode only asks over ACP when its own config says "ask", and a user's
// agent can allow everything). One server per driver on 127.0.0.1; each agent
// process gets its own Bearer token, which names the thread the call belongs to.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { PermissionDecision } from "../../../shared/types";

/** What the plugin sends for one tool call. */
export interface PluginAsk {
  /** OpenCode's tool id (bash, edit, write, ...). */
  tool: string;
  kind: "edit" | "execute";
  /** The command, or the file the edit touches. */
  summary: string;
  /** OpenCode's call id: the same id its own ACP ask (if any) arrives under. */
  callID?: string;
  sessionID?: string;
}

export interface AskServer {
  url: string;
  /** A token for one agent process; its asks go to `answer` until `revoke`. */
  register(answer: (ask: PluginAsk) => Promise<PermissionDecision>): string;
  revoke(token: string): void;
  close(): Promise<void>;
}

const MAX_BODY = 64 * 1024;

export async function startAskServer(): Promise<AskServer> {
  const handlers = new Map<string, (ask: PluginAsk) => Promise<PermissionDecision>>();
  const handlerFor = (header: string | undefined) => {
    const m = /^Bearer (\S+)$/.exec(header ?? "");
    if (!m) return null;
    const given = Buffer.from(m[1]!);
    for (const [token, answer] of handlers) {
      const want = Buffer.from(token);
      if (want.length === given.length && timingSafeEqual(want, given)) return answer;
    }
    return null;
  };
  const http = createServer((req, res) => {
    const answer = handlerFor(req.headers.authorization);
    if (!answer) return void res.writeHead(401).end();
    if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end();
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) req.destroy();
      else body += chunk.toString("utf8");
    });
    req.on("end", () => {
      let ask: PluginAsk;
      try {
        ask = JSON.parse(body) as PluginAsk;
      } catch {
        return void res.writeHead(400).end();
      }
      if ((ask.kind !== "edit" && ask.kind !== "execute") || typeof ask.tool !== "string") return void res.writeHead(400).end();
      const reply = (decision: PermissionDecision) => {
        if (!res.writableEnded) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ decision }));
      };
      // An answer that throws is a refusal: the plugin fails closed either way.
      answer({ ...ask, summary: String(ask.summary ?? "") }).then(reply, () => reply("deny"));
    });
  });
  // A user may take minutes to answer a card: never time the request out.
  http.requestTimeout = 0;
  http.headersTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve());
  });
  http.unref();
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/ask`,
    register: (answer) => {
      const token = randomBytes(24).toString("hex");
      handlers.set(token, answer);
      return token;
    },
    revoke: (token) => void handlers.delete(token),
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}
