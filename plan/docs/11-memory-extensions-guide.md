## 11. One Memory, One Registry, One Small Guide: Harness-Owned Memory, Extension Delivery, and a Guide That Doesn't Bloat

**Thesis.** Chapter 10 priced what re-enters context on a switch. This chapter decides what the harness itself owns. The answer is **learned memory** and **the extension registry**. Each agent's **instruction files** (`CLAUDE.md`, `AGENTS.md`) stay native, because they are committed repo rules that teammates and CI read outside CubiQ. Status: decision doc, no code yet. Research date 2026-09-29.

### 11.0 What a first "hi" actually costs (measured)

| Agent | First-turn context | Where it goes |
|---|---|---|
| Claude Code, bare SDK, this repo (Haiku, `claude_code` preset, no CubiQ additions) | **22.7k** | System prompt 6.4k · built-in tool schemas 8.2k · memory files 2.2k · skills list 2.0k · messages/reminders 3.8k; another 15.9k of tool schemas are *deferred* behind tool search and cost nothing |
| Claude via CubiQ (Opus 5.5, other project) | 35.4k (17.2k cache-write, $0.07) | the above plus CubiQ's guide, 7 browser tools, the skills plugin and user MCP. The Phase A breakdown attributes it per thread |
| Codex via CubiQ | 18–26k | Codex base instructions + tools + guide + browser tools |
| OpenCode via CubiQ | ~13k | OpenCode prompt + guide + tools |

Consequences: (1) most of the cost is the CLI's own prefix, which CubiQ can't remove without dropping the CLI's features; (2) turn 1 is a **cache write** (1.25×) and later turns read at 0.1×; (3) **every model or agent switch pays the prefix again**, because caches are per model (Ch. 10 §10.1). The biggest cost control is to switch less, not to trim the guide.

### 11.1 What the field does

| Pattern | Who | Verdict for CubiQ |
|---|---|---|
| Pass-through (each agent keeps its own memory) | t3code, Conductor, Nimbalyst, Zed ACP | What we do today. Zero cost, but Claude's learned facts vanish when you switch to Codex |
| Harness memory, injected | ZCode (`~/.zcode/cli/memories/projects/<p>/memory/MEMORY.md` + one file per fact, **off by default**, index size-capped), WorkBuddy (on by default, nightly summaries), Goose (Memory MCP + `.goosehints`) | **Adopt**, in ZCode's format |
| Single source compiled into each native file | ruler, rulesync | Good for rules, but it churns committed files. Not for memory |
| Own registry → native delivery per agent | ZCode, vibe-kanban (writes agents' *global* configs), opcode | We already do this without writing global configs. Keep it |
| Harness as one MCP hub | vibe-kanban `--mcp`, rulesync `mcp`, Goose | Already true for Codex/ACP (`mcp-http.ts`) |

Sources: zcode.z.ai/en/docs/memory · zcode.z.ai/en/docs/safety-confirm · github.com/zai-org/ZCode · github.com/pingdotgg/t3code (docs/user, docs/internals) · workbuddy.ai/docs/workbuddy · github.com/intellectronica/ruler · github.com/dyoshikawa/rulesync · github.com/BloopAI/vibe-kanban · opencode.ai/docs/rules · goose-docs.ai.

### 11.2 Memory: shared harness memory that replaces each agent's native memory

The user wants this on by default, with every agent using the shared memory instead of its own. It's feasible, and each native memory has a verified switch:

| Agent | Native learned memory | How CubiQ takes it over |
|---|---|---|
| Claude | auto-memory in `~/.claude/projects/<cwd>/memory/` | SDK setting **`autoMemoryDirectory`** (`sdk.d.ts:8852`): point it *at the CubiQ memory folder*. Claude then reads and writes the shared store with its own tools, in the same `MEMORY.md` + fact-file format. `autoMemoryEnabled:false` is the hard off switch |
| Codex 0.157 | `memories` feature (`memories.use_memories`, `memories.generate_memories` in the binary) | Set both to `false` in the thread `config` on `thread/start`. Confirm the exact keys with `codex app-server generate-ts --experimental` first. Put the index in `developerInstructions` |
| OpenCode / ACP | none (rules only) | Index goes into the `<harness-guide>` first prompt |

**Import once, on enable:** copy `~/.claude/projects/<cwd>/memory/*.md` and `~/.codex/memories/*` into `<userData>/memory/projects/<projectId>/`, dedupe by title, rebuild `MEMORY.md`. Keep the originals untouched so turning memory off restores native behaviour.

**Keep native:** `CLAUDE.md`, `AGENTS.md`, `.claude/rules`. `claudeMdExcludes` could hide them, but that silently breaks repo conventions, so it stays a documented escape hatch and is never a default.

**Cost controls, so "on by default" stays cheap:**
1. **Reads are an index, not bodies.** Only `MEMORY.md` goes into the prompt (titles + one-line hooks, capped at about 1–1.5k tokens, like Claude's 200-line cap). Bodies load on demand: Claude reads the file itself, and other agents use a harness `memory_read` MCP tool.
2. **The index sits in the stable prefix and is frozen per session.** It is rebuilt only at session start, never mid-session, so after turn 1 it bills as a cache read (0.1×). A mid-session rewrite would break the prefix (Ch. 4 §4.2).
3. **Writes happen off the main context, on a free or cheap model.** Claude writes its own memory (it's in its prompt already). For Codex and ACP agents, a background extractor runs after the turn, debounced, on the cheapest configured model (AgentRouter DeepSeek Flash or Haiku). It gets only that turn's delta (user text, final answer, decisions), never the transcript, and emits add/update/delete ops against the index. The main agent pays nothing for this.
4. **Record what ZCode and Claude record, nothing else:** user preferences, feedback, project goals and constraints, external references. No code structure, git history or chat logs.
5. **User control:** a Library tab lists memories (edit/delete), a per-project toggle, and the extractor model picker.

### 11.3 Extensions: MCP, skills, plugins, custom agents

Keep **own registry → native delivery** (already built: `mcp/servers.ts`, `skills/catalog.ts`, `agents/registry.ts`, delivered as plugin / extraRoots / envDir / skill tool). Changes:
- **Import, never write back.** The Library gets "Import from Claude / Codex / OpenCode" using the reads `mcp/external.ts` already does. CubiQ never edits `~/.claude.json` or `~/.codex/config.toml` (vibe-kanban does, and it surprises other tools).
- **Skills stay on the Agent Skills standard** (`SKILL.md`, `.agents/skills/`), which Claude, Codex, OpenCode and Goose all read. The user trigger is `$name`, like Codex, and `/` is reserved for CubiQ commands.
- **Plugins:** accept `.claude-plugin/plugin.json` bundles (as ZCode does) and unpack them into the registry: skills to the catalog, MCP to `mcp.json`, agents to `agents.json`.
- **Custom subagents:** one `.agents/agents/*.md` format, passed to Claude through the SDK `agents` option and to Codex as its agent config. Only the name and description go into the prompt.

### 11.4 The agent guide (HARNESS.md): yes, but tiny and static

- Keep it: agents need to know about the browser pane, `$` skills, Plan mode and the git guard. They can't find that out any other way.
- **Budget ≤ 600 tokens, static per session** (`guide.ts` already caches by mtime). Describe *capabilities and rules*, never tool schemas, since the tools describe themselves.
- **Let native progressive disclosure do the work.** Skills: metadata only, body on demand (Claude plugin / Codex extraRoots already behave this way). MCP: Claude tool search defers schemas (the 15.9k "deferred" row above). Keep harness MCP servers deferred-eligible (don't set `alwaysLoad`).
- One line in the guide saying "search memory before asking the user something you may have been told" gets memory used without injecting bodies.

### 11.5 Order of work (next round)
1. Memory store + import + index injection (Claude via `autoMemoryDirectory`, Codex/ACP via guide channel), with the Library tab.
2. Background extractor on a cheap model for Codex/ACP.
3. Extension import + `.claude-plugin` bundles.
4. Guide diet to ≤ 600 tokens, measured with the Phase A breakdown.
