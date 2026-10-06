import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readExternalMcp, readExternalSpec } from "../src/main/mcp/external";
import { tempDir } from "./helpers";

describe("readExternalSpec", () => {
  it("imports a Claude stdio server with its args and env", () => {
    const home = tempDir();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      mcpServers: {
        gh: { command: "gh-mcp", args: ["serve", "--flag"], env: { TOKEN: "test-value-1", COUNT: 3 } },
        sse: { type: "sse", url: "https://example.test/sse", headers: { Authorization: "Bearer test-value-1" } },
        http: { url: "https://example.test/mcp" },
      },
    }));

    expect(readExternalSpec("Claude", "~/.claude.json", "gh", { home, env: {} })).toEqual({ type: "stdio", command: "gh-mcp", args: ["serve", "--flag"], env: { TOKEN: "test-value-1" } });
    expect(readExternalSpec("Claude", "~/.claude.json", "sse", { home, env: {} })).toEqual({ type: "sse", url: "https://example.test/sse", headers: { Authorization: "Bearer test-value-1" } });
    expect(readExternalSpec("Claude", "~/.claude.json", "http", { home, env: {} })).toEqual({ type: "http", url: "https://example.test/mcp" });
  });

  it("imports the project-scope Claude servers from both files", () => {
    const home = tempDir();
    const project = tempDir();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { [project]: { mcpServers: { local: { command: "loc" } } } } }));
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "srv", args: [] } } }));

    expect(readExternalSpec("Claude", "~/.claude.json (this project)", "local", { home, projectPath: project, env: {} })).toEqual({ type: "stdio", command: "loc" });
    expect(readExternalSpec("Claude", ".mcp.json", "shared", { home, projectPath: project, env: {} })).toEqual({ type: "stdio", command: "srv" });
  });

  it("imports a Codex server with env, inline headers, a bearer var, and CRLF", () => {
    const home = tempDir();
    mkdirSync(join(home, ".codex"));
    const toml = [
      "model = \"x\"",
      "[mcp_servers.fs]",
      "command = \"npx\"",
      "args = [\"-y\", \"fs-mcp\"]",
      "[mcp_servers.fs.env]",
      "TOKEN = \"test-value-1\"",
      "COUNT = 3",
      "[mcp_servers.web]",
      "url = \"https://example.test/mcp\"",
      "http_headers = { \"X-Key\" = \"test-value-2\", X_Other = 'test-value-3' }",
      "bearer_token_env_var = \"WEB_TOKEN\"",
      "[mcp_servers.sub]",
      "url = \"https://example.test/sub\"",
      "[mcp_servers.sub.http_headers]",
      "X-Sub = \"test-value-4\"",
      "",
    ].join("\r\n");
    writeFileSync(join(home, ".codex", "config.toml"), toml);

    expect(readExternalSpec("Codex", "~/.codex/config.toml", "fs", { home, env: {} })).toEqual({ type: "stdio", command: "npx", args: ["-y", "fs-mcp"], env: { TOKEN: "test-value-1" } });
    expect(readExternalSpec("Codex", "~/.codex/config.toml", "web", { home, env: {} })).toEqual({
      type: "http",
      url: "https://example.test/mcp",
      headers: { "X-Key": "test-value-2", X_Other: "test-value-3", Authorization: "Bearer ${WEB_TOKEN}" },
    });
    expect(readExternalSpec("Codex", "~/.codex/config.toml", "sub", { home, env: {} })).toEqual({ type: "http", url: "https://example.test/sub", headers: { "X-Sub": "test-value-4" } });
  });

  it("imports Codex from an explicit CODEX_HOME", () => {
    const codexHome = tempDir();
    writeFileSync(join(codexHome, "config.toml"), '[mcp_servers.fs]\ncommand = "fs-mcp"\n');

    expect(readExternalSpec("Codex", "~/.codex/config.toml", "fs", { home: tempDir(), env: { CODEX_HOME: codexHome } })).toEqual({ type: "stdio", command: "fs-mcp" });
  });

  it("imports Gemini httpUrl as http and a plain url as sse", () => {
    const home = tempDir();
    mkdirSync(join(home, ".gemini"));
    writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({
      mcpServers: {
        http: { httpUrl: "https://example.test/http", headers: { "X-Key": "test-value-1" } },
        sse: { url: "https://example.test/sse" },
        stdio: { command: "gem", args: ["serve"], env: { G: "test-value-2" } },
      },
    }));

    expect(readExternalSpec("Gemini", "~/.gemini/settings.json", "http", { home, env: {} })).toEqual({ type: "http", url: "https://example.test/http", headers: { "X-Key": "test-value-1" } });
    expect(readExternalSpec("Gemini", "~/.gemini/settings.json", "sse", { home, env: {} })).toEqual({ type: "sse", url: "https://example.test/sse" });
    expect(readExternalSpec("Gemini", "~/.gemini/settings.json", "stdio", { home, env: {} })).toEqual({ type: "stdio", command: "gem", args: ["serve"], env: { G: "test-value-2" } });
  });

  it("imports OpenCode local and remote servers", () => {
    const home = tempDir();
    const xdg = join(home, "xdg");
    mkdirSync(join(xdg, "opencode"), { recursive: true });
    writeFileSync(join(xdg, "opencode", "opencode.json"), JSON.stringify({
      mcp: {
        local: { type: "local", command: ["bunx", "o-mcp", "--x"], environment: { O: "test-value-1" } },
        remote: { type: "remote", url: "https://example.test/mcp", headers: { "X-Key": "test-value-2" } },
      },
    }));

    const opts = { home, env: { XDG_CONFIG_HOME: xdg } };
    expect(readExternalSpec("OpenCode", "~/.config/opencode/opencode.json", "local", opts)).toEqual({ type: "stdio", command: "bunx", args: ["o-mcp", "--x"], env: { O: "test-value-1" } });
    expect(readExternalSpec("OpenCode", "~/.config/opencode/opencode.json", "remote", opts)).toEqual({ type: "http", url: "https://example.test/mcp", headers: { "X-Key": "test-value-2" } });
  });

  it("returns null for a missing name, the wrong source, or an unknown shape", () => {
    const home = tempDir();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { gh: { command: "gh-mcp" }, odd: { enabled: true } } }));

    expect(readExternalSpec("Claude", "~/.claude.json", "nope", { home, env: {} })).toBeNull();
    expect(readExternalSpec("Codex", "~/.codex/config.toml", "gh", { home, env: {} })).toBeNull();
    expect(readExternalSpec("Claude", "~/.claude.json", "odd", { home, env: {} })).toBeNull();
  });

  it("marks a row importable only when it has a usable shape", () => {
    const home = tempDir();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      mcpServers: {
        gh: { command: "gh-mcp", args: ["serve"], env: { TOKEN: "test-value-1" } },
        odd: { enabled: true },
      },
    }));

    const found = readExternalMcp({ home, projectPath: null, env: {} });
    expect(found.find((s) => s.name === "gh")?.importable).toBe(true);
    const odd = found.find((s) => s.name === "odd");
    expect(odd?.type).toBe("unknown");
    expect(odd?.importable).toBeUndefined();
    expect(JSON.stringify(found)).not.toContain("test-value-1");
  });
});
