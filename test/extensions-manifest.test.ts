import { describe, expect, it } from "vitest";
import {
  CONNECTOR_MAX_BYTES,
  SKILL_MAX_FILES,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_TOTAL_BYTES,
  computeProposalDigest,
  requiredVarsOf,
  validateProposal,
} from "../src/main/extensions/manifest";

const GLOBAL = { scope: { kind: "global" as const }, reservedNames: ["browser", "docx"] };

describe("validateProposal (skills)", () => {
  const validSkill = {
    kind: "skill",
    name: "commit-msg",
    description: "Write conventional commit messages: feat, fix, chore.",
    files: [
      {
        path: "SKILL.md",
        content: "---\nname: commit-msg\ndescription: placeholder\n---\n\n# Commit Message\n\nFollow conventional commits.\n",
      },
      {
        path: "examples/feat.txt",
        content: "feat(auth): add token refresh\n",
      },
    ],
  };

  it("accepts a valid skill, normalizes description in frontmatter, and produces a stable digest across file order", () => {
    const res1 = validateProposal(validSkill, GLOBAL);
    expect(res1.ok).toBe(true);
    if (!res1.ok) return;
    expect(res1.proposal.draft.kind).toBe("skill");
    if (res1.proposal.draft.kind !== "skill") return;
    const skillMd = res1.proposal.draft.files.find((f) => f.path === "SKILL.md")!;
    expect(skillMd.content).toContain('description: "Write conventional commit messages: feat, fix, chore."');

    const reordered = {
      ...validSkill,
      files: [...validSkill.files].reverse(),
    };
    const res2 = validateProposal(reordered, GLOBAL);
    expect(res2.ok).toBe(true);
    if (!res2.ok) return;
    expect(res2.proposal.digest).toBe(res1.proposal.digest);
    expect(computeProposalDigest(GLOBAL.scope, res1.proposal.draft)).toBe(res1.proposal.digest);
  });

  it("rejects invalid or reserved names", () => {
    expect(validateProposal({ ...validSkill, name: "Bad_Name" }, GLOBAL)).toMatchObject({ ok: false });
    expect(validateProposal({ ...validSkill, name: "-leading" }, GLOBAL)).toMatchObject({ ok: false });
    expect(validateProposal({ ...validSkill, name: "cubiq" }, GLOBAL)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("reserved")]),
    });
    expect(validateProposal({ ...validSkill, name: "browser" }, GLOBAL)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("reserved")]),
    });
  });

  it("rejects missing SKILL.md, mismatched frontmatter name, or mode: in frontmatter", () => {
    expect(
      validateProposal({ ...validSkill, files: [{ path: "notes.md", content: "hi" }] }, GLOBAL),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("SKILL.md")]),
    });

    expect(
      validateProposal(
        {
          ...validSkill,
          files: [{ path: "SKILL.md", content: "---\nname: other-name\n---\nBody" }],
        },
        GLOBAL,
      ),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('must equal "commit-msg"')]),
    });

    expect(
      validateProposal(
        {
          ...validSkill,
          files: [{ path: "SKILL.md", content: "---\nname: commit-msg\nmode: design\n---\nBody" }],
        },
        GLOBAL,
      ),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("mode:")]),
    });
  });

  it("rejects unsafe paths, dotfiles, case-insensitive duplicates, disallowed extensions, NUL bytes, and size limits", () => {
    for (const badPath of ["../x.md", "..\\x.md", "C:\\x.md", "/abs.md", "sub/../x.md", ".env", "sub/.hidden.md", "run.sh", "script.py"]) {
      const r = validateProposal(
        {
          ...validSkill,
          files: [validSkill.files[0]!, { path: badPath, content: "x" }],
        },
        GLOBAL,
      );
      expect(r.ok, `expected path "${badPath}" to fail`).toBe(false);
    }

    const dup = validateProposal(
      {
        ...validSkill,
        files: [validSkill.files[0]!, { path: "skill.md", content: "dup" }],
      },
      GLOBAL,
    );
    expect(dup).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("Duplicate file path")]),
    });

    const nul = validateProposal(
      {
        ...validSkill,
        files: [validSkill.files[0]!, { path: "notes.md", content: "hello\0world" }],
      },
      GLOBAL,
    );
    expect(nul).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("NUL byte")]),
    });

    const tooBigFile = validateProposal(
      {
        ...validSkill,
        files: [validSkill.files[0]!, { path: "big.md", content: "a".repeat(SKILL_MAX_FILE_BYTES + 1) }],
      },
      GLOBAL,
    );
    expect(tooBigFile).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("per-file limit")]),
    });

    const tooManyFiles = validateProposal(
      {
        ...validSkill,
        files: [
          validSkill.files[0]!,
          ...Array.from({ length: SKILL_MAX_FILES }, (_, i) => ({ path: `f${i}.md`, content: "x" })),
        ],
      },
      GLOBAL,
    );
    expect(tooManyFiles).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining(`at most ${SKILL_MAX_FILES} files`)]),
    });

    const chunk = "a".repeat(100 * 1024);
    const tooBigTotal = validateProposal(
      {
        ...validSkill,
        files: [
          validSkill.files[0]!,
          ...Array.from({ length: Math.ceil(SKILL_MAX_TOTAL_BYTES / (100 * 1024)) + 1 }, (_, i) => ({
            path: `part-${i}.txt`,
            content: chunk,
          })),
        ],
      },
      GLOBAL,
    );
    expect(tooBigTotal).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("total limit")]),
    });
  });
});

describe("validateProposal (connectors)", () => {
  it("accepts stdio and https connectors with ${VAR} placeholders and extracts required vars", () => {
    const stdio = validateProposal(
      {
        kind: "connector",
        name: "github",
        spec: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", EMPTY_OK: "" },
        },
      },
      GLOBAL,
    );
    expect(stdio.ok).toBe(true);
    if (stdio.ok && stdio.proposal.draft.kind === "connector") {
      expect(requiredVarsOf(stdio.proposal.draft.spec)).toEqual(["GITHUB_TOKEN"]);
    }

    const http = validateProposal(
      {
        kind: "connector",
        name: "linear",
        spec: {
          type: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "${LINEAR_TOKEN}" },
        },
      },
      GLOBAL,
    );
    expect(http.ok).toBe(true);

    const localhost = validateProposal(
      {
        kind: "connector",
        name: "local-mcp",
        spec: {
          type: "sse",
          url: "http://127.0.0.1:8787/sse",
        },
      },
      GLOBAL,
    );
    expect(localhost.ok).toBe(true);
  });

  it("a header may put Bearer/Token/Basic before one placeholder, nothing else", () => {
    const header = (v: string) => validateProposal({ kind: "connector", name: "gh", spec: { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: v } } }, GLOBAL);
    for (const ok of ["Bearer ${GITHUB_TOKEN}", "Token ${GITHUB_TOKEN}", "Basic ${B64_CREDS}", "${AUTH}"]) expect(header(ok).ok, ok).toBe(true);
    for (const bad of ["Bearer sk-live-1", "Bearer ${A}${B}", "Bearer ${A} x", "bearer ${A}", "Bearer  ${A}", "X ${A}", "Bearer ${lower}"]) expect(header(bad).ok, bad).toBe(false);
    const check = header("Bearer ${GITHUB_TOKEN}");
    expect(check.ok && requiredVarsOf(check.proposal.draft.kind === "connector" ? check.proposal.draft.spec : ({} as never))).toEqual(["GITHUB_TOKEN"]);
  });

  it("rejects literal secrets in env or headers, non-localhost http URLs, clientSecret, multiline commands, and oversized JSON", () => {
    expect(
      validateProposal(
        {
          kind: "connector",
          name: "bad-header",
          spec: {
            type: "http",
            url: "https://mcp.example.com",
            headers: { Authorization: "Bearer sk-live-12345" },
          },
        },
        GLOBAL,
      ),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("placeholders")]),
    });

    expect(
      validateProposal(
        {
          kind: "connector",
          name: "bad-env",
          spec: {
            type: "stdio",
            command: "npx",
            env: { API_KEY: "secret-value" },
          },
        },
        GLOBAL,
      ),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("placeholders")]),
    });

    expect(
      validateProposal(
        {
          kind: "connector",
          name: "plain-http",
          spec: {
            type: "http",
            url: "http://example.com/mcp",
          },
        },
        GLOBAL,
      ),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("https:")]),
    });

    expect(
      validateProposal(
        {
          kind: "connector",
          name: "oauth-secret",
          spec: {
            type: "http",
            url: "https://example.com/mcp",
            oauth: { clientId: "cid", clientSecret: "top-secret" },
          },
        },
        GLOBAL,
      ),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("oauth.clientSecret")]),
    });

    expect(
      validateProposal(
        {
          kind: "connector",
          name: "newline-cmd",
          spec: {
            type: "stdio",
            command: "npx\nrm -rf /",
          },
        },
        GLOBAL,
      ),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("single-line")]),
    });

    expect(
      validateProposal(
        {
          kind: "connector",
          name: "huge-connector",
          note: "x".repeat(CONNECTOR_MAX_BYTES + 100),
          spec: {
            type: "stdio",
            command: "npx",
          },
        },
        GLOBAL,
      ),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("limit")]),
    });
  });
});
