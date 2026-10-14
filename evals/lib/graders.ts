// Pure graders for the eval framework: score one finished trial against a
// task's graders. Disk reads are real; the shell is injected as runCommand.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claimsPass, ranChecks } from "../../src/main/evidence";
import type { CompactEvent, GradeInput, Grader, GraderResult } from "./types";

type Verdict = { pass: boolean; why: string };

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
};

const sha256 = (path: string): string | null => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
};

function gradeFile(g: Extract<Grader, { type: "file" }>, dir: string, fixtureDir: string): Verdict {
  const full = join(dir, g.path);
  const text = readText(full);
  const exists = existsSync(full);
  if (g.exists !== undefined && exists !== g.exists) {
    return { pass: false, why: g.exists ? `${g.path} missing` : `${g.path} exists` };
  }
  if (g.contains !== undefined) {
    if (text === null) return { pass: false, why: `${g.path} missing` };
    if (!text.includes(g.contains)) return { pass: false, why: `${g.path} does not contain "${g.contains}"` };
  }
  if (g.matches !== undefined) {
    if (text === null) return { pass: false, why: `${g.path} missing` };
    if (!new RegExp(g.matches).test(text)) return { pass: false, why: `${g.path} does not match /${g.matches}/` };
  }
  if (g.unchanged !== undefined) {
    const same = sha256(full) === sha256(join(fixtureDir, g.path));
    if (same !== g.unchanged) return { pass: false, why: g.unchanged ? `${g.path} changed` : `${g.path} unchanged` };
  }
  let why: string;
  if (g.contains !== undefined) why = `${g.path} contains "${g.contains}"`;
  else if (g.matches !== undefined) why = `${g.path} matches /${g.matches}/`;
  else if (g.unchanged !== undefined) why = `${g.path} ${g.unchanged ? "unchanged" : "changed"}`;
  else if (g.exists !== undefined) why = g.exists ? `${g.path} exists` : `${g.path} missing`;
  else why = `${g.path} ok`;
  return { pass: true, why };
}

async function gradeCommand(g: Extract<Grader, { type: "command" }>, input: GradeInput): Promise<Verdict> {
  const r = await input.runCommand(g.run, input.dir, g.timeoutMs ?? 60000);
  if (r.ok) return { pass: true, why: `${g.run} ok` };
  return { pass: false, why: `${g.run} failed (exit ${r.exitCode ?? "?"}): ${r.tail.slice(-200)}` };
}

function gradeTool(g: Extract<Grader, { type: "tool" }>, events: CompactEvent[]): Verdict {
  const count = events.filter((e) => e.kind === "tool-use" && e.name === g.name).length;
  const min = g.min ?? 0;
  const max = g.max ?? Infinity;
  return { pass: count >= min && count <= max, why: `${g.name} called ${count}× (want ${min}..${max})` };
}

function gradeSkill(g: Extract<Grader, { type: "skill" }>, input: GradeInput): Verdict {
  if (!input.sentinels) return { pass: false, why: "no skill kit" };
  const haystack = JSON.stringify(input.events);
  const loaded = [...new Set([...input.sentinels].filter(([sentinel]) => haystack.includes(sentinel)).map(([, name]) => name))];
  if (g.none) {
    return loaded.length === 0 ? { pass: true, why: "no skill loaded" } : { pass: false, why: `loaded ${loaded.join(", ")}` };
  }
  const want = g.expect ?? [];
  const missing = want.filter((name) => !loaded.includes(name));
  if (missing.length) return { pass: false, why: `missing ${missing.join(", ")}` };
  return { pass: true, why: want.length ? `loaded ${want.join(", ")}` : "no skill expected" };
}

function gradeEvent(g: Extract<Grader, { type: "event" }>, events: CompactEvent[]): Verdict {
  if (g.noError && events.some((e) => e.kind === "error")) return { pass: false, why: "saw an error event" };
  if (g.noFalseClaim) {
    const answer = events.filter((e) => e.kind === "assistant-text").map((e) => e.text ?? "").join("\n");
    const commands = events.filter((e) => e.kind === "tool-use" && e.name === "Run").map((e) => e.summary ?? "");
    if (claimsPass(answer) && !ranChecks(commands)) return { pass: false, why: "claimed checks pass but none ran" };
  }
  const parts: string[] = [];
  if (g.noError) parts.push("no errors");
  if (g.noFalseClaim) parts.push("no unsupported pass claim");
  return { pass: true, why: parts.join("; ") || "no event checks" };
}

function gradeAnswer(g: Extract<Grader, { type: "answer" }>, events: CompactEvent[]): Verdict {
  const answer = events.filter((e) => e.kind === "assistant-text").map((e) => e.text ?? "").join("\n");
  const missing = (g.contains ?? []).filter((c) => !answer.toLowerCase().includes(c.toLowerCase()));
  if (missing.length) return { pass: false, why: `answer lacks ${missing.map((m) => `"${m}"`).join(", ")}` };
  if (g.matches !== undefined && !new RegExp(g.matches, "i").test(answer)) return { pass: false, why: `answer does not match /${g.matches}/i` };
  return { pass: true, why: "answer ok" };
}

export async function grade(input: GradeInput): Promise<GraderResult[]> {
  const run = async (g: Grader): Promise<Verdict> => {
    switch (g.type) {
      case "file":
        return gradeFile(g, input.dir, input.fixtureDir);
      case "command":
        return gradeCommand(g, input);
      case "tool":
        return gradeTool(g, input.events);
      case "skill":
        return gradeSkill(g, input);
      case "event":
        return gradeEvent(g, input.events);
      case "answer":
        return gradeAnswer(g, input.events);
      case "budget":
        return { pass: !input.overBudget, why: input.overBudget ? "over budget" : "within budget" };
    }
  };
  const out: GraderResult[] = [];
  for (const g of input.task.graders) {
    const v = await run(g);
    out.push({ type: g.type, pass: v.pass, required: g.required ?? true, weight: g.weight ?? 1, why: v.why });
  }
  return out;
}

export function score(results: GraderResult[]): { pass: boolean; score: number } {
  const pass = results.every((r) => !r.required || r.pass);
  const total = results.reduce((sum, r) => sum + r.weight, 0);
  const earned = results.reduce((sum, r) => sum + (r.pass ? r.weight : 0), 0);
  return { pass, score: total === 0 ? 1 : earned / total };
}
