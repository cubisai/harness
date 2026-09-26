import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import type { AgentCapabilities, PermissionRequest } from "../src/shared/types";
import { CantDoList, CapabilityChips, cantDo } from "../src/renderer/src/components/Capabilities";
import { PermissionCardView } from "../src/renderer/src/components/PermissionCard";

const warn: AgentCapabilities = {
  ...SAFE_DEFAULTS,
  guardEnforcement: { ask: "warnOnly", "auto-edit": "warnOnly", full: "warnOnly" },
  mcpHttp: false,
};

const blocked: AgentCapabilities = {
  ...SAFE_DEFAULTS,
  guardEnforcement: { ask: "block", "auto-edit": "block", full: "block" },
  mcpHttp: true,
};

const mixed: AgentCapabilities = {
  ...SAFE_DEFAULTS,
  guardEnforcement: { ask: "block", "auto-edit": "block", full: "warnOnly" },
};

const request: PermissionRequest = { requestId: "r1", threadId: "t1", toolName: "Bash", summary: "git push --force", canAlwaysAllow: true };

describe("CapabilityChips", () => {
  it("words a warn-only guard and a missing HTTP transport", () => {
    const html = renderToStaticMarkup(<CapabilityChips capabilities={warn} />);
    expect(html).toContain("warn-only");
    expect(html).toContain("MCP over HTTP: no");
  });

  it("words a blocking guard and a working HTTP transport", () => {
    const html = renderToStaticMarkup(<CapabilityChips capabilities={blocked} />);
    expect(html).toContain("Guardrails: block");
    expect(html).toContain("MCP over HTTP: yes");
  });

  it("names the modes where a blocking guard only warns", () => {
    const html = renderToStaticMarkup(<CapabilityChips capabilities={mixed} />);
    expect(html).toContain("Guardrails: block (warn-only in Full)");
  });
});

describe("CantDoList", () => {
  it("lists the warn-only guard and the missing HTTP transport", () => {
    const html = renderToStaticMarkup(<CantDoList capabilities={warn} />);
    expect(html).toContain("warn-only");
    expect(html).toContain("MCP over HTTP");
  });

  it("says nothing about git or MCP when both are covered", () => {
    const items = cantDo(blocked).join(" ");
    expect(items).not.toMatch(/git/i);
    expect(items).not.toMatch(/MCP/);
  });
});

describe("PermissionCardView", () => {
  it("shows the warn-only guard notice", () => {
    const html = renderToStaticMarkup(<PermissionCardView request={request} guard="warnOnly" agentLabel="Codex" onRespond={() => {}} />);
    expect(html).toContain("warn-only");
  });

  it("shows the blocking guard notice and not the warn-only one", () => {
    const html = renderToStaticMarkup(<PermissionCardView request={request} guard="block" agentLabel="Claude" onRespond={() => {}} />);
    expect(html).toContain("blocked before they run");
    expect(html).not.toContain("warn-only");
  });

  it("shows no guard notice when the agent reports no enforcement", () => {
    const html = renderToStaticMarkup(<PermissionCardView request={request} guard={undefined} agentLabel="this agent" onRespond={() => {}} />);
    expect(html).not.toContain("warn-only");
    expect(html).not.toContain("blocked before they run");
  });
});
