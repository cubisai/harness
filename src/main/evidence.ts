// The evidence gate: after a turn, flag what makes its "done" worth a second
// look — existing tests edited or deleted, new skip/only/trivial asserts, or a
// "tests pass" claim with no test command run. It only shows a notice; it
// never blocks, and it stays silent when nothing fires.

/** Test files by the usual naming conventions across languages. */
const TEST_PATH =
  /(^|\/)(__tests__|tests?|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|(^|\/)[^/]+Tests?\.(java|kt|cs|swift)$|_spec\.rb$/i;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path.replace(/\\/g, "/"));
}

/** What weakens a test, by the label the notice uses. */
const MARKERS: [RegExp, string][] = [
  [/\b(?:it|test|describe|context|suite)\.(?:skip|only|todo)\s*\(/, ".skip/.only"],
  [/\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(/, ".skip/.only"],
  [/@pytest\.mark\.(?:skip|xfail)\b|\bpytest\.skip\(|@unittest\.skip/, "skip"],
  [/\bt\.Skip(?:Now|f)?\(/, "skip"],
  [/@(?:Disabled|Ignore)\b/, "skip"],
  [/expect\((true|1)\)\.toBe\(\1\)|\bassert\s+True\b|assert\.ok\(true\)|assertTrue\(true\)/, "trivial assert"],
];

/** Count of each marker label in some added lines. */
export function markerCounts(lines: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of lines) {
    for (const [re, label] of MARKERS) {
      if (re.test(line)) {
        out.set(label, (out.get(label) ?? 0) + 1);
        break;
      }
    }
  }
  return out;
}

/** The added lines of a unified diff, without their "+". */
export function addedLines(unified: string): string[] {
  return unified
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
}

/** Labels whose count grew from `before` to `after`. */
export function newMarkers(before: Map<string, number>, after: Map<string, number>): string[] {
  return [...after].filter(([label, n]) => n > (before.get(label) ?? 0)).map(([label]) => label);
}

const CLAIM =
  /\b(?:tests?|specs?|checks?|test suite|suite|build|typecheck|type check|lint)\s+(?:now\s+|all\s+|still\s+)?(?:pass(?:es|ed|ing)?|succeed(?:s|ed)?|(?:is|are)\s+(?:green|passing|clean))\b|\ball\s+(?:\d+\s+)?(?:tests?|checks?)\s+(?:now\s+)?pass/i;
const NEGATED = /\b(?:not|never|no|without|unable|cannot)\b|n't\b|\b(?:if|should|would|could|might|once|ensure|make sure)\b|\bto (?:make|check|confirm|verify|see)\b/i;

/** Whether the answer states, unhedged, that tests or checks pass. */
export function claimsPass(answer: string): boolean {
  return answer.split(/(?<=[.!?])\s+|\n+/).some((s) => CLAIM.test(s) && !NEGATED.test(s));
}

const CHECK_COMMAND =
  /\b(?:test|tests|vitest|jest|mocha|ava|pytest|unittest|tox|nox|rspec|phpunit|ctest|tsc|typecheck|lint|eslint|biome|ruff|mypy|pyright|clippy|check|build|gradle|gradlew|mvn|make)\b/i;

/** Commands that only print, read, search, or manage files/git, even when arguments mention "test" or "build". */
const NON_CHECK_VERB =
  /^(?:echo|printf|cat|head|tail|less|more|ls|pwd|find|grep|egrep|fgrep|rg|ripgrep|git|sed|awk|cp|mv|rm|mkdir|rmdir|touch|chmod|chown|true|false|sleep|wc|sort|uniq|cut|tr|diff|stat|file|which|type)\b/i;

/** Harness tools that are a check run of their own, under any MCP prefix (`mcp__cubiq__design_lint`, `cubiq_design_lint`). */
const CHECK_TOOL = /(?:^|[_.])design_lint$/;

export function isCheckTool(tool: string): boolean {
  return CHECK_TOOL.test(tool);
}

/** Whether a shell command (or any sub-command in a `&&`/`||`/`;`/`|`/`\n` chain) runs a check. */
export function isCheckCommand(command: string): boolean {
  for (const raw of command.split(/&&|\|\||[;|\n]/)) {
    let seg = raw.trim();
    while (/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+/.test(seg)) {
      seg = seg.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+/, "").trim();
    }
    if (!seg || /^cd(?:\s|$)/i.test(seg)) continue;
    const verb = seg.replace(/^(?:\.\/|\/[^\s/]+\/)+/, "");
    if (NON_CHECK_VERB.test(verb)) continue;
    if (CHECK_COMMAND.test(seg)) return true;
  }
  return false;
}

/** Whether any of the turn's commands looks like a test, typecheck, lint or build run, or it called a check tool. */
export function ranChecks(commands: readonly string[], tools: readonly string[] = []): boolean {
  return commands.some(isCheckCommand) || tools.some(isCheckTool);
}

export type EvidenceStep =
  | {
      kind: "check";
      command?: string;
      tool?: string;
      ok: boolean;
      exitCode?: number | null;
      cwd?: string;
      revision?: string | number;
    }
  | {
      kind: "edit";
      path?: string;
      revision?: string | number;
    };

export type VerificationStatus = "passed" | "failed" | "stale" | "not-run";

export interface EvidenceInput {
  /** Test files that existed before the turn and changed in it. */
  editedTests: string[];
  deletedTests: string[];
  /** Test files with newly added skip/only/trivial-assert lines, and which ones. */
  weakened: { path: string; labels: string[] }[];
  /** The user's request: when it's about tests, editing them is expected. */
  request: string;
  answer: string;
  commands: string[];
  /** The names of the tools the turn called: a design turn's `design_lint` is its check run. */
  tools?: string[];
  /** Ordered ledger of check runs and edits during the turn, when tracked. */
  steps?: readonly EvidenceStep[];
  /** The project's check gate ran this turn and passed. */
  checkPassed: boolean;
  /** The project's check gate ran this turn and failed. */
  checkFailed?: boolean;
}

/** Resolve the turn's verification status from its ordered ledger (or legacy command/tool lists). */
export function verificationStatus(i: Pick<EvidenceInput, "commands" | "tools" | "steps" | "checkPassed" | "checkFailed">): VerificationStatus {
  if (i.checkPassed) return "passed";
  if (i.checkFailed) return "failed";
  if (i.steps) {
    let status: VerificationStatus = "not-run";
    let passedRevision: string | number | undefined;
    for (const s of i.steps) {
      if (s.kind === "check") {
        const isCheck =
          (s.command !== undefined ? isCheckCommand(s.command) : false) ||
          (s.tool !== undefined ? isCheckTool(s.tool) : false) ||
          (s.command === undefined && s.tool === undefined);
        if (!isCheck) continue;
        const ok = s.ok && (s.exitCode === undefined || s.exitCode === null || s.exitCode === 0);
        if (ok) {
          status = "passed";
          passedRevision = s.revision;
        } else {
          status = "failed";
        }
      } else if (s.kind === "edit") {
        if (status === "passed") status = "stale";
      } else if (passedRevision !== undefined && (s as { revision?: string | number }).revision !== undefined && (s as { revision?: string | number }).revision !== passedRevision) {
        if (status === "passed") status = "stale";
      }
    }
    return status;
  }
  return ranChecks(i.commands, i.tools) ? "passed" : "not-run";
}

const list = (paths: string[]) => {
  const shown = paths.slice(0, 3).join(", ");
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
};

/** The notice lines for a finished turn; empty when nothing needs a second look. */
export function evidenceFlags(i: EvidenceInput): string[] {
  const flags: string[] = [];
  const aboutTests = /\b(?:tests?|specs?|testing)\b/i.test(i.request);
  if (i.deletedTests.length) flags.push(`Deleted test files: ${list(i.deletedTests)}.`);
  for (const w of i.weakened) flags.push(`Added ${w.labels.join(" and ")} in ${w.path}.`);
  const weakenedPaths = new Set(i.weakened.map((w) => w.path));
  const edited = i.editedTests.filter((p) => !weakenedPaths.has(p));
  if (edited.length && !aboutTests) flags.push(`Changed existing tests: ${list(edited)}. Check they weren't loosened to pass.`);
  if (claimsPass(i.answer)) {
    const status = verificationStatus(i);
    if (status === "not-run") flags.push("Says tests or checks pass, but none ran this turn.");
    else if (status === "failed") flags.push("Says tests or checks pass, but the last check failed.");
    else if (status === "stale") flags.push("Says tests or checks pass, but files were edited after the last check.");
  }
  return flags;
}
