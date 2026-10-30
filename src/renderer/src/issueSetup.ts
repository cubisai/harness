import type { IssueTracker, Question, QuestionAnswer } from "../../shared/types";

/** /issue-setup's own questions, asked in the app's card before any agent runs, so every agent gets the same choices. */

const HOSTS: { id: Exclude<IssueTracker, "local">; label: string; cli: string }[] = [
  { id: "github", label: "GitHub", cli: "gh" },
  { id: "gitlab", label: "GitLab", cli: "glab" },
  { id: "gitea", label: "Gitea", cli: "tea" },
];
const RECOMMENDED = " (Recommended)";

/** The git host an `origin` URL points at, by its hostname; null when it doesn't say. */
export function hostOf(remote: string | null): Exclude<IssueTracker, "local"> | null {
  if (!remote) return null;
  const host = (/^[\w+.-]+:\/\/(?:[^@/]*@)?([^/:]+)/.exec(remote) ?? /^(?:[^@]+@)?([^:/]+):/.exec(remote))?.[1]?.toLowerCase() ?? "";
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (host.includes("gitlab")) return "gitlab";
  if (host.includes("gitea") || host.includes("codeberg")) return "gitea";
  return null;
}

/** The owner/name path in an `origin` URL, without `.git`; null when there's none. */
export function repoOf(remote: string | null): string | null {
  if (!remote) return null;
  const path = (/^[\w+.-]+:\/\/[^/]+\/(.+)$/.exec(remote) ?? /^(?:[^@]+@)?[^:/]+:(.+)$/.exec(remote))?.[1];
  return path ? path.replace(/\.git\/?$/, "").replace(/\/$/, "") || null : null;
}

/** Tracker, labels and templates: the detected host first and recommended, Local first when there's no remote. */
export function setupQuestions(remote: string | null): Question[] {
  const detected = hostOf(remote);
  const repo = repoOf(remote);
  const hosts = HOSTS.map((h) => ({
    label: h.id === detected ? `${h.label}${RECOMMENDED}` : h.label,
    description: h.id === detected && repo ? `${repo}, through the ${h.cli} CLI` : `Issues and PRs on ${h.label}, through the ${h.cli} CLI`,
  }));
  const local = { label: remote ? "Local" : `Local${RECOMMENDED}`, description: "One markdown file per issue in docs/issues/, committed with the repo" };
  const ordered = detected ? [hosts.find((h) => h.label.endsWith(RECOMMENDED))!, ...hosts.filter((h) => !h.label.endsWith(RECOMMENDED)), local] : [local, ...hosts];
  return [
    { id: "tracker", header: "Tracker", question: "Where should this project's issues live?", options: ordered, multiSelect: false, allowOther: false },
    {
      id: "labels",
      header: "Labels",
      question: "Which labels should issues use?",
      options: [
        { label: `Defaults${RECOMMENDED}`, description: "bug, enhancement, documentation, and the states needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix; only missing ones are created" },
        { label: "My own names", description: "The agent asks for your name for each label, and reuses ones the host already has" },
      ],
      multiSelect: false,
      allowOther: false,
    },
    {
      id: "templates",
      header: "Templates",
      question: "Add issue and PR templates to the repo (git hosts only)?",
      options: [
        { label: `Add them${RECOMMENDED}`, description: "Bug, enhancement and PR templates, so issues filed on the web get the same structure; existing files are kept" },
        { label: "No templates", description: "Nothing added to the repo" },
      ],
      multiSelect: false,
      allowOther: false,
    },
  ];
}

const plain = (label: string | undefined): string => (label ?? "").replace(RECOMMENDED, "").trim();

/** The message the setup skill gets from the card's answers; null when the user skipped the card. */
export function setupMessage(answer: QuestionAnswer, remote: string | null): string | null {
  if (answer === "dismiss") return null;
  const pick = (id: string, fallback: string) => plain(answer.answers[id]?.[0]) || fallback;
  const tracker = pick("tracker", hostOf(remote) ? HOSTS.find((h) => h.id === hostOf(remote))!.label : "Local");
  const lines = [
    `Tracker: ${tracker}`,
    `Labels: ${pick("labels", "Defaults")}`,
    ...(tracker === "Local" ? [] : [`Templates: ${pick("templates", "Add them")}`]),
    ...(remote ? [`The origin remote is ${remote}.`] : []),
  ];
  return lines.join("\n");
}
