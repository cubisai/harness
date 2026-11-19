import { describe, expect, it } from "vitest";
import { canonicalTool, toolLabel } from "../src/shared/tools";

describe("toolLabel: tool rows read as words, not ids", () => {
  it("names CubiQ's own tools in words, whichever engine called them", () => {
    expect(toolLabel("run_code")).toBe("Script");
    expect(toolLabel("mcp__cubiq__run_code")).toBe("Script");
    expect(toolLabel("browser_screenshot")).toBe("Screenshot");
    expect(toolLabel("mcp__cubiq__design_lint")).toBe("Design check");
    expect(toolLabel("design_tokens_apply")).toBe("Apply tokens");
  });

  it("spells an unknown id as words and keeps display names as they are", () => {
    expect(toolLabel("design_new_thing")).toBe("Design new thing");
    expect(toolLabel("some-kebab-tool")).toBe("Some kebab tool");
    expect(toolLabel("Bash")).toBe("Run");
    expect(toolLabel("Edit")).toBe("Edit");
    expect(toolLabel("Agent")).toBe("Agent");
  });

  it("reads a skill load and Creator's steps as what they do", () => {
    expect(toolLabel("Skill")).toBe("Load skill");
    expect(toolLabel("skill")).toBe("Load skill");
    expect(toolLabel("mcp__cubiq__creator_inspect")).toBe("Inspect");
    expect(toolLabel("creator_app_preview")).toBe("Preview app");
    expect(toolLabel("creator_app_check")).toBe("Check app");
    expect(toolLabel("creator_connector_test")).toBe("Test connector");
    expect(toolLabel("creator_propose")).toBe("Propose");
  });

  it("keeps another MCP server's name and words its tool", () => {
    expect(toolLabel("mcp__github__create_issue")).toBe("github · Create issue");
  });

  it("names the tool a browser_call or call_mcp_tool row called", () => {
    expect(toolLabel("browser_call", { tool: "browser_open", arguments: { url: "https://x.dev" } })).toBe("Open page");
    expect(toolLabel("call_mcp_tool", { server: "linear", tool: "list_issues" })).toBe("linear · List issues");
    expect(toolLabel("call_mcp_tool")).toBe("Tool");
  });

  it("leaves canonicalTool (what logic compares) unchanged", () => {
    expect(canonicalTool("mcp__cubiq__run_code")).toBe("run_code");
    expect(canonicalTool("browser_screenshot")).toBe("browser_screenshot");
  });
});
