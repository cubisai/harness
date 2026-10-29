// Types for the test-only mock extension kit generator.

export interface MockSkill {
  name: string;
  description: string;
  body: string;
  sentinel: string;
}

export interface MockToolProperty {
  type: "string" | "number" | "boolean";
  description: string;
}

export interface MockTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, MockToolProperty>;
    required: string[];
  };
  sentinel: string;
}

export type MockEvalKind = "skill" | "tool" | "none" | "ambiguous";

export interface MockEval {
  id: string;
  prompt: string;
  expect: string[];
  kind: MockEvalKind;
}

export interface MockManifest {
  seed: number;
  counts: { skills: number; servers: number; tools: number };
  skills: { name: string; description: string; sentinel: string }[];
  tools: { server: string; name: string; description: string; sentinel: string }[];
  evals: MockEval[];
}

export const PRESETS: Record<"small" | "medium" | "large", { skills: number; servers: number; tools: number }>;

export function rng(seed: number): () => number;

export function makeSkills(count: number, seed: number): MockSkill[];

export function makeTools(serverName: string, count: number, seed: number): MockTool[];

export function serverNames(count: number, seed: number): string[];

export function makeEvals(skills: MockSkill[], toolsByServer: Record<string, MockTool[]>, seed: number): MockEval[];

export function generate(opts: {
  skills: number;
  servers: number;
  tools: number;
  seed: number;
  serverScript: string;
}): { files: { path: string; content: string }[]; manifest: MockManifest };
