import { describe, expect, it } from "vitest";
import { Approvals, canonicalPattern, permissionTable } from "../src/main/approvals";

describe("canonicalPattern", () => {
  it("trims and collapses whitespace", () => {
    expect(canonicalPattern("  npm   test ")).toBe("npm test");
  });

  it("keeps whitespace inside quotes", () => {
    expect(canonicalPattern('echo "a  b"   x')).toBe('echo "a  b" x');
  });

  it("straightens typographic quotes", () => {
    expect(canonicalPattern("echo “hi”")).toBe('echo "hi"');
  });
});

describe("Approvals", () => {
  it("keys an allow-always by agent, tool and canonical pattern", () => {
    const approvals = new Approvals();
    approvals.remember("claude", "Bash", "npm  test");
    expect(approvals.get("codex", "Run", "npm test")).toBeUndefined();
    expect(approvals.get("claude", "Bash", "npm test")).toBe("allow-always");
    expect(approvals.get("codex", "Bash", "npm test")).toBeUndefined();
  });
});

describe("permissionTable", () => {
  it("maps every mode to every driver", () => {
    expect(permissionTable()).toMatchSnapshot();
    expect(Object.keys(permissionTable())).toHaveLength(3);
    const entries = Object.values(permissionTable()).reduce((n, row) => n + Object.keys(row).length, 0);
    expect(entries).toBe(9);
    expect(permissionTable().ask.codex).toEqual({ approvalPolicy: "untrusted", sandbox: "workspace-write" });
  });
});
