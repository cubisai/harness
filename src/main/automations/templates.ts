// Starter automations the Library's Automations tab offers: prompt, schedule and budget.

import type { AutomationTemplate, Schedule } from "../../shared/automations";

/** The machine's IANA zone, so a template's "09:00" means the user's morning. */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const NO_EDITS = "Don't edit any files.";

/** The templates, in the order the picker lists them, scheduled daily at 09:00 in `timeZone`. */
export function templates(timeZone = localZone()): AutomationTemplate[] {
  const daily = (): Schedule => ({ kind: "daily", at: "09:00", timeZone });
  return [
    {
      id: "repo-health",
      name: "Repo health",
      description: "Run the project's checks and report what passed and what each failure was.",
      prompt: `Run the project's check command (or its usual typecheck, lint and test scripts) and report what passed, each failure with its first error, and the smallest next step. ${NO_EDITS}`,
      schedule: daily(),
      budgetUsd: 0.5,
    },
    {
      id: "browser-smoke",
      name: "Browser smoke test",
      description: "Drive the dev server in the browser and report PASS or FAIL with evidence.",
      prompt: `Start the project's dev server with the dev_server tool, open it in the browser, exercise the main page, and finish with browser_report (PASS or FAIL with evidence). ${NO_EDITS}`,
      schedule: daily(),
      budgetUsd: 0.5,
    },
    {
      id: "project-brief",
      name: "Project brief",
      description: "Summarise what changed since the last run from the commit list.",
      prompt: `Summarise what changed since the last run from the commit list under "## Sources": the themes, the risky changes, and the follow-ups worth doing next. ${NO_EDITS}`,
      schedule: daily(),
      budgetUsd: 0.25,
    },
    {
      id: "eval-regression",
      name: "Eval regression",
      description: "Run the validation eval split and flag anything that regressed.",
      prompt: `Run \`bun run eval --split validation --max-usd 1\` and report the pass rate against the previous run and any task that regressed. ${NO_EDITS}`,
      schedule: daily(),
      budgetUsd: 1,
    },
    {
      id: "custom",
      name: "Custom",
      description: "Start from scratch with your own prompt, schedule and budget.",
      prompt: "",
      schedule: daily(),
      budgetUsd: null,
    },
  ];
}

export function templateById(id: string, timeZone = localZone()): AutomationTemplate | undefined {
  return templates(timeZone).find((t) => t.id === id);
}

/** The templates in the machine's zone, resolved once for callers that don't pick a zone. */
export const TEMPLATES: AutomationTemplate[] = templates();
