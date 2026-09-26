import type { Server } from "node:http";

export interface FakeOpenAIRequest {
  model?: string;
  tools?: { name?: string; tools?: { name: string }[] }[];
  input?: unknown;
}

export interface FakeOpenAI {
  server: Server;
  url: string;
  offered: string[][];
  namespaces: string[][];
  requests: FakeOpenAIRequest[];
  authHeaders: (string | null)[];
}

export function startFakeOpenAI(opts?: { requireAuth?: boolean }): Promise<FakeOpenAI>;
