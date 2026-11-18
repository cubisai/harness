import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ExtensionProposalView } from "../src/shared/types";
import { ProposalCardView, type ProposalCardViewProps, previewMarkdown } from "../src/renderer/src/components/ProposalCard";

const SKILL_MD = "---\nname: conventional-commits\ndescription: Writes a commit message.\n---\n\n# Conventional commits\n\nRead the diff.\n";

const skill = (extra: Partial<ExtensionProposalView> = {}): ExtensionProposalView => ({
  id: "pr1",
  threadId: "t1",
  scope: { kind: "project", projectId: "p1" },
  projectName: "acme-web",
  projectChoice: null,
  status: "staged",
  createdAt: 0,
  updatedAt: 0,
  draft: {
    kind: "skill",
    name: "conventional-commits",
    description: "Writes a Conventional Commits message.",
    files: [
      { path: "SKILL.md", bytes: 1840 },
      { path: "reference/types.md", bytes: 612 },
    ],
    skillMd: SKILL_MD,
  },
  ...extra,
});

const connector = (type: "stdio" | "http", extra: Partial<ExtensionProposalView> = {}): ExtensionProposalView => ({
  ...skill(),
  id: "pr2",
  scope: { kind: "global" },
  draft: {
    kind: "connector",
    name: "github",
    type,
    target: type === "stdio" ? "npx -y @modelcontextprotocol/server-github" : "https://mcp.example.com/mcp",
    requiredVars: type === "stdio" ? ["GITHUB_TOKEN"] : [],
  },
  ...extra,
});

const noop = () => {};
const render = (proposal: ExtensionProposalView, props: Partial<ProposalCardViewProps> = {}) =>
  renderToStaticMarkup(
    <ProposalCardView proposal={proposal} busy={null} actionError={null} previewOpen={false} onTogglePreview={noop} onInstall={noop} onReject={noop} {...props} />,
  );
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));

describe("ProposalCardView", () => {
  it("a staged skill shows its files, scope and the Install/Reject actions, preview closed", () => {
    const html = render(skill());
    expect(html).toContain("conventional-commits");
    expect(html).toContain("Project: acme-web");
    expect(html).toContain("reference/types.md");
    expect(html).toContain("1.8 KB");
    expect(html).toContain("612 B");
    expect(buttons(html)).toEqual(["Preview SKILL.md", "Reject", "Install"]);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Read the diff.");
    expect(html).not.toContain("proposal-status");
  });

  it("the open preview draws the frontmatter as a yaml block, not a run-on paragraph", () => {
    const html = render(skill(), { previewOpen: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Hide SKILL.md");
    expect(html).toContain("name: conventional-commits");
    expect(html).toContain("Read the diff.");
    expect(html).not.toContain("<p>---");
  });

  it("with a project to choose, the user picks Install to Project or Global; finished cards show the chip only", () => {
    const withChoice = skill({ projectChoice: { id: "p1", name: "acme-web" } });
    const html = render(withChoice, { scopePick: "global", onScopePick: noop });
    expect(html).toContain('aria-label="Install to"');
    expect(buttons(html)).toEqual(["Preview SKILL.md", "Project: acme-web", "Global", "Reject", "Install"]);
    expect(html).toMatch(/class="on" aria-pressed="true"[^>]*>Global</);
    expect(html).not.toContain("proposal-chip\">Project: acme-web");
    const installed = render(skill({ projectChoice: { id: "p1", name: "acme-web" }, status: "installed", installId: "i1" }), { scopePick: "project", onScopePick: noop });
    expect(installed).not.toContain("Install to");
    expect(installed).toContain("Project: acme-web");
    // A Chats thread has no project: no picker, Global chip.
    expect(render(connector("http"), { onScopePick: noop })).not.toContain("Install to");
  });

  it("a stdio connector shows the exact command, the local-program line and the variables it needs", () => {
    const html = render(connector("stdio"));
    expect(html).toContain("Global");
    expect(html).toContain("npx -y @modelcontextprotocol/server-github");
    expect(html).toContain("Runs a local program on this computer.");
    expect(html).toContain("${GITHUB_TOKEN}");
  });

  it("a remote connector has no local-program line or variables list", () => {
    const html = render(connector("http"));
    expect(html).toContain("https://mcp.example.com/mcp");
    expect(html).not.toContain("Runs a local program");
    expect(html).not.toContain("Required variables");
  });

  it("busy disables both actions and names the one running", () => {
    const html = render(skill(), { busy: "install" });
    expect(buttons(html)).toEqual(["Preview SKILL.md", "Reject", "Installing…"]);
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
  });

  it("installed: a status chip and the Library link, no Install", () => {
    const html = render(skill({ status: "installed", installId: "i1" }));
    expect(html).toContain("Installed");
    expect(buttons(html)).toEqual(["Preview SKILL.md", "Open in Library"]);
  });

  it("rejected: a status chip and no actions", () => {
    const html = render(connector("http", { status: "rejected" }));
    expect(html).toContain("Rejected");
    expect(buttons(html)).toEqual([]);
  });

  it("failed: the error stays visible; Retry only when retryable", () => {
    const error = "A skill named conventional-commits already exists in Project: acme-web.";
    const retry = render(skill({ status: "failed", error, retryable: true }));
    expect(retry).toContain('role="alert"');
    expect(retry).toContain(error);
    expect(buttons(retry)).toEqual(["Preview SKILL.md", "Reject", "Retry"]);
    const changed = render(skill({ status: "failed", error: "Changed after review.", retryable: false }));
    expect(buttons(changed)).toEqual(["Preview SKILL.md", "Reject"]);
  });

  it("an action error from IPC shows even while staged", () => {
    expect(render(skill(), { actionError: "Refused: not the main window." })).toContain("Refused: not the main window.");
  });

  it("model-provided text is escaped, never HTML", () => {
    const html = render(connector("stdio", { draft: { kind: "connector", name: '<img src=x onerror="alert(1)">', type: "stdio", target: "<b>run</b>", requiredVars: [] } }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>run</b>");
    expect(html).toContain("&lt;img");
  });
});

describe("previewMarkdown", () => {
  it("turns leading frontmatter into a yaml fence and keeps the body", () => {
    expect(previewMarkdown(SKILL_MD)).toBe("```yaml\nname: conventional-commits\ndescription: Writes a commit message.\n```\n\n\n# Conventional commits\n\nRead the diff.\n");
  });
  it("handles CRLF and leaves text without frontmatter alone", () => {
    expect(previewMarkdown("---\r\nname: a\r\n---\r\nbody")).toBe("```yaml\nname: a\n```\n\nbody");
    expect(previewMarkdown("# Title\n\n---\n")).toBe("# Title\n\n---\n");
  });
});
