import type { Server } from "node:http";

export interface FakeOpenAIRequest {
  tools?: { name?: string; tools?: { name: string }[] }[];
  input?: unknown;
}

export interface FakeOpenAI {
  server: Server;
  url: string;
  offered: string[][];
  namespaces: string[][];
  requests: FakeOpenAIRequest[];
}

export function startFakeOpenAI(opts?: { requireAuth?: boolean }): Promise<FakeOpenAI>;
