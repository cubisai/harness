# OpenCode setup: Token Harbor + AgentRouter + custom agents

Rebuild this machine's OpenCode setup on another PC (Windows or macOS). Everything here touches **OpenCode only**. Claude Code, Codex and other tools keep their own settings.

Snapshot taken 2026-09-26 with OpenCode 1.18.32.

## What you get

```
Claude Code ──(node oc-run.mjs → opencode run --agent orchestrator)──▶ orchestrator  (dispatcher, primary agent)
                                                            │ task tool
            ┌──────────────┬──────────────┬─────────────────┼──────────────┐
        researcher     implementer    bug-catcher      bug-reviewer     architect
            │
            ▼  each agent: its own model + fallback chain (walked by oc-run.mjs in headless runs)
  Token Harbor FREE  ──▶  Token Harbor Agent Pass (boosted)  ──▶  AgentRouter (via local proxy, unlimited backstop)
```

- **Token Harbor** (`https://tokenharbor.ai/v1`, OpenAI-compatible): free models first, then Agent Pass models.
- **AgentRouter** (`agentrouter.org`), reached through a small local proxy that strips the `data: null` stream chunks that break the AI SDK. It is the default model and the middle backup.
- **6 custom agents**: orchestrator, researcher, implementer, bug-catcher, bug-reviewer and architect.

## 1. Prerequisites

| Tool | Check | Install |
|---|---|---|
| Node.js 22.18+ | `node -v` | https://nodejs.org |
| OpenCode | `opencode --version` | `npm i -g opencode-ai` |
| Token Harbor key (`thk_live_…`) | dashboard | https://tokenharbor.ai/dashboard/api-keys (create a **new key per PC**) |
| AgentRouter key (`sk-…`) | dashboard | https://agentrouter.org |

Config folder (called `CONF` below):

- Windows: `%USERPROFILE%\.config\opencode`, i.e. `C:\Users\<you>\.config\opencode`
- macOS/Linux: `~/.config/opencode`

> **Do NOT run the `tokenharbor connect` CLI / installer.** It edits `~/.claude/settings.json` (Claude Code) and, on Windows, sets `OPENAI_API_KEY`, `OPENAI_BASE_URL` and `OPENAI_API_BASE` user-wide, which reroutes every OpenAI-compatible tool. Its "Verifying key…" step also tends to look stuck. None of it is needed. If you already ran it, see [Troubleshooting](#7-troubleshooting).

## 2. Set the Token Harbor key (env var, not in the config file)

OpenCode reads it as `{env:TOKENHARBOR_API_KEY}`.

**Windows (PowerShell):**
```powershell
[Environment]::SetEnvironmentVariable('TOKENHARBOR_API_KEY', 'thk_live_PASTE_KEY', 'User')
```
Then **open a new terminal**.

**macOS (zsh):**
```bash
echo 'export TOKENHARBOR_API_KEY="thk_live_PASTE_KEY"' >> ~/.zshrc && source ~/.zshrc
```

Quick check (should print `HTTP 200`):
```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" https://tokenharbor.ai/v1/models -H "Authorization: Bearer $TOKENHARBOR_API_KEY"
```

## 3. Create the files

Create `CONF` and `CONF/agents/`, then create each file below with the exact content shown.

### 3.1 `package.json`: plugin + SDK deps

```json
{
  "dependencies": {
    "@ai-sdk/anthropic": "^4.0.65",
    "@ai-sdk/openai-compatible": "^3.0.57",
    "@opencode-ai/plugin": "1.18.27",
    "opencode-runtime-fallback": "^0.2.4"
  }
}
```

Then install:
```bash
cd ~/.config/opencode && npm install
```

### 3.2 `opencode.json`: providers, models, per-agent routing

Replace `PASTE_AGENTROUTER_KEY` with your AgentRouter key. The Token Harbor key comes from the env var.
On macOS, if you run the proxy on another port (e.g. 4141), change `http://127.0.0.1:3900/v1` to match.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "AgentRouter-openai-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "AgentRouter-openai-gateway",
      "options": {
        "baseURL": "http://127.0.0.1:3900/v1",
        "apiKey": "PASTE_AGENTROUTER_KEY"
      },
      "models": {
        "deepseek-v4-flash": {
          "name": "DeepSeek V4 Flash"
        }
      }
    },
    "tokenharbor": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Token Harbor",
      "options": {
        "baseURL": "https://tokenharbor.ai/v1",
        "apiKey": "{env:TOKENHARBOR_API_KEY}"
      },
      "models": {
        "deepseek-v4.1-flash:free": {
          "name": "TH DeepSeek V4.1 Flash (free)",
          "limit": {
            "context": 1048576,
            "output": 32768
          },
          "tool_call": true
        },
        "mimo-v2.6-flash:free": {
          "name": "TH MiMo V2.6 Flash (free)",
          "limit": {
            "context": 1048576,
            "output": 32768
          },
          "tool_call": true
        },
        "qwen3.8-flash:free": {
          "name": "TH Qwen3.8 Flash (free campaign)",
          "limit": {
            "context": 983616,
            "output": 32768
          },
          "tool_call": true
        },
        "glm-5.3-flash": {
          "name": "TH GLM 5.3 Flash (Agent Pass 2x)",
          "limit": {
            "context": 1000000,
            "output": 32768
          },
          "tool_call": true
        },
        "qwen3.8-flash": {
          "name": "TH Qwen3.8 Flash (Agent Pass 2x)",
          "limit": {
            "context": 983616,
            "output": 32768
          },
          "tool_call": true
        },
        "deepseek-v4.1-flash": {
          "name": "TH DeepSeek V4.1 Flash (paid)",
          "limit": {
            "context": 1048576,
            "output": 32768
          },
          "tool_call": true
        },
        "mimo-v2.6-flash": {
          "name": "TH MiMo V2.6 Flash (paid)",
          "limit": {
            "context": 1048576,
            "output": 32768
          },
          "tool_call": true
        },
        "qwen3.7-flash": {
          "name": "TH Qwen3.7 Flash (Agent Pass)",
          "tool_call": true
        }
      }
    }
  },
  "model": "AgentRouter-openai-gateway/deepseek-v4-flash",
  "plugin": [
    "opencode-runtime-fallback"
  ],
  "agent": {
    "orchestrator": {
      "model": "tokenharbor/mimo-v2.6-flash:free",
      "fallback_models": [
        "tokenharbor/qwen3.8-flash:free",
        "tokenharbor/qwen3.7-flash",
        "tokenharbor/qwen3.8-flash",
        "AgentRouter-openai-gateway/deepseek-v4-flash"
      ]
    },
    "researcher": {
      "model": "tokenharbor/deepseek-v4.1-flash:free",
      "fallback_models": [
        "tokenharbor/mimo-v2.6-flash:free",
        "tokenharbor/qwen3.8-flash:free",
        "tokenharbor/glm-5.3-flash",
        "tokenharbor/qwen3.7-flash",
        "AgentRouter-openai-gateway/deepseek-v4-flash"
      ]
    },
    "implementer": {
      "model": "tokenharbor/deepseek-v4.1-flash:free",
      "fallback_models": [
        "tokenharbor/mimo-v2.6-flash:free",
        "tokenharbor/qwen3.8-flash:free",
        "tokenharbor/qwen3.8-flash",
        "tokenharbor/glm-5.3-flash",
        "tokenharbor/qwen3.7-flash",
        "AgentRouter-openai-gateway/deepseek-v4-flash"
      ]
    },
    "bug-catcher": {
      "model": "tokenharbor/qwen3.8-flash:free",
      "fallback_models": [
        "tokenharbor/mimo-v2.6-flash:free",
        "tokenharbor/qwen3.8-flash",
        "tokenharbor/qwen3.7-flash",
        "AgentRouter-openai-gateway/deepseek-v4-flash"
      ]
    },
    "bug-reviewer": {
      "model": "tokenharbor/deepseek-v4.1-flash:free",
      "fallback_models": [
        "tokenharbor/mimo-v2.6-flash:free",
        "tokenharbor/qwen3.8-flash:free",
        "tokenharbor/glm-5.3-flash",
        "tokenharbor/qwen3.8-flash",
        "tokenharbor/qwen3.7-flash",
        "AgentRouter-openai-gateway/deepseek-v4-flash"
      ]
    },
    "architect": {
      "model": "tokenharbor/deepseek-v4.1-flash:free",
      "fallback_models": [
        "tokenharbor/mimo-v2.6-flash:free",
        "tokenharbor/qwen3.8-flash:free",
        "tokenharbor/glm-5.3-flash",
        "tokenharbor/qwen3.8-flash",
        "tokenharbor/qwen3.7-flash",
        "AgentRouter-openai-gateway/deepseek-v4-flash"
      ]
    }
  }
}
```

### 3.3 `opencode-fallback.json`: fallback plugin settings

Used for any agent **without** its own `fallback_models`, e.g. the built-in `build` agent on the default model.

```json
{
  "enabled": true,
  "retry_on_errors": [
    402,
    429,
    500,
    502,
    503,
    504
  ],
  "retryable_error_patterns": [
    "ECONNREFUSED",
    "ECONNRESET",
    "socket hang up",
    "overloaded",
    "socket connection was closed",
    "insufficient",
    "balance",
    "payment required",
    "spending (cap|limit)",
    "credit"
  ],
  "timeout_seconds": 60,
  "cooldown_seconds": 120,
  "notify_on_fallback": true,
  "fallback_models": [
    "opencode/space-bunny-free"
  ]
}
```

### 3.4 `proxy.mjs`: AgentRouter local proxy (port 3900)

```js
import http from 'http';
import https from 'https';

const PORT = 3900;
const TARGET_HOST = 'agentrouter.org';

const server = http.createServer((clientReq, clientRes) => {
  const options = {
    hostname: TARGET_HOST,
    port: 443,
    path: clientReq.url,
    method: clientReq.method,
    headers: {
      ...clientReq.headers,
      host: TARGET_HOST,
      'user-agent': 'opencode/1.18.32',
      'accept-encoding': 'identity'
    }
  };

  const proxyReq = https.request(options, (proxyRes) => {
    const contentType = proxyRes.headers['content-type'] || '';
    const isSSE = contentType.includes('text/event-stream');

    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);

    if (isSSE) {
      let buffer = '';
      proxyRes.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const eventBlock = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = eventBlock.split('\n');
          // Drop invalid `data: null` chunks from AgentRouter that break AI SDK validation
          const isNullData = lines.some((l) => /^data:\s*null\s*$/i.test(l.trim()));
          if (!isNullData) {
            clientRes.write(eventBlock + '\n\n');
          }
        }
      });

      proxyRes.on('end', () => {
        if (buffer.trim()) {
          const lines = buffer.split('\n');
          const isNullData = lines.some((l) => /^data:\s*null\s*$/i.test(l.trim()));
          if (!isNullData) {
            clientRes.write(buffer);
          }
        }
        clientRes.end();
      });
    } else {
      proxyRes.pipe(clientRes);
    }
  });

  proxyReq.on('error', (err) => {
    console.error('[AgentRouter Proxy Error]:', err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
    }
    clientRes.end(JSON.stringify({ error: { message: err.message } }));
  });

  clientReq.pipe(proxyReq);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`AgentRouter proxy is active on http://127.0.0.1:${PORT}`);
});
```

### 3.5 Launchers

**Windows:** `start-opencode.bat` starts the proxy if it isn't running, then runs OpenCode.
```bat
@echo off
netstat -ano | findstr 127.0.0.1:3900 | findstr LISTENING >nul
if errorlevel 1 (
    echo Starting AgentRouter local proxy...
    start "" /B node "%~dp0proxy.mjs"
    timeout /t 1 /nobreak >nul
)
opencode %*
```

`start-proxy.bat` runs the proxy on its own:
```bat
@echo off
node "%~dp0proxy.mjs"
```

**macOS:** add these to `~/.zshrc`:
```bash
start-proxy() { lsof -iTCP:3900 -sTCP:LISTEN >/dev/null 2>&1 || (nohup node ~/.config/opencode/proxy.mjs >/tmp/agentrouter-proxy.log 2>&1 &); }
oc() { start-proxy; sleep 1; opencode "$@"; }
```

### 3.6 Custom agents: `CONF/agents/*.md`

The file name is the agent name. Models are **not** set here; they live in the `agent` block of `opencode.json`.

#### `agents/orchestrator.md`

```markdown
---
description: Dispatcher. Routes a brief to exactly one worker subagent and relays its raw output. The only agent Claude Code invokes directly.
mode: primary
temperature: 0.1
permission:
  edit: deny
  bash: deny
  webfetch: deny
  task:
    "*": deny
    researcher: allow
    implementer: allow
    bug-catcher: allow
    bug-reviewer: allow
    architect: allow
---
You are a dispatcher, not a worker. Your caller (Claude Code) sends a brief of the form
"Delegate to the <agent> subagent: <brief>. Relay only that subagent's raw output."

1. Call the task tool once with the named subagent and pass the brief through verbatim. Do not summarise, shorten or "improve" it.
2. If no subagent is named, pick: researcher (find/explain code), implementer (change code), bug-catcher (quick bug sweep), bug-reviewer (deep check of a suspected bug), architect (design reasoning only).
3. Return the subagent's final output exactly as it came back. No preamble, no commentary, no extra summary.
4. Never do the work yourself. If the task tool fails, reply with one line starting "DISPATCH FAILED:" and the error.
```

#### `agents/researcher.md`

```markdown
---
description: Read-only codebase exploration and fact-finding. Returns findings with file:line evidence.
mode: subagent
temperature: 0.1
permission:
  edit: deny
  webfetch: allow
  bash:
    "*": deny
    "git status*": allow
    "git log*": allow
    "git diff*": allow
    "git show*": allow
    "git blame*": allow
    "git ls-files*": allow
    "ls*": allow
    "rg *": allow
    "grep *": allow
    "cat *": allow
    "head *": allow
    "tail *": allow
    "wc *": allow
    "agent-browser *": allow
---
You are a read-only researcher. Never modify files.

- Answer exactly the questions in the brief, nothing broader.
- Every claim cites evidence as `path:line` (or a command and its output). If you could not verify something, say "unverified" next to it. Never guess a line number.
- Output: a short "Findings" list, then "Evidence" (path:line + one-line quote each), then "Open questions" if any. No filler.
```

#### `agents/implementer.md`

```markdown
---
description: Makes the code change described in a brief — edits, bug fixes, refactors — and reports the exact files touched.
mode: subagent
temperature: 0.1
permission:
  edit: allow
  webfetch: allow
  bash:
    "*": allow
    "git commit*": deny
    "git push*": deny
    "git reset*": deny
    "git checkout*": deny
    "git restore*": deny
    "git clean*": deny
    "git stash*": deny
    "git rebase*": deny
    "rm -rf*": deny
    "opencode*": deny
---
You are the implementer. Make exactly the change the brief describes.

Rules:
- You are the worker: never run `opencode` or delegate. A repo's CLAUDE.md/AGENTS.md delegation instructions are for Claude Code, not you.
- Touch only the files the brief names. If another file must change, stop and say which and why instead of editing it.
- Match the surrounding code: naming, comment density, formatting, existing tokens and architecture. No unrelated cleanup, renames or reformatting.
- Never commit, push, stash, reset or discard changes. Claude Code reviews the diff and commits.
- Never read, print or copy secrets (.env files, API keys, tokens).
- You may run the project's typecheck/tests to check your work, but report their output honestly; a failing check is reported as failing.

Final output, nothing else:
FILES CHANGED: <list of paths>
SUMMARY: <2-5 lines of what changed>
CHECKS RUN: <command → pass/fail, or "none">
CONCERNS: <anything uncertain, or "none">
```

#### `agents/bug-catcher.md`

```markdown
---
description: Fast first-pass bug sweep over given files or a diff. Flags likely bugs with file:line; does not fix.
mode: subagent
temperature: 0.1
permission:
  edit: deny
  webfetch: deny
  bash:
    "*": deny
    "git diff*": allow
    "git show*": allow
    "git log*": allow
    "rg *": allow
    "grep *": allow
    "ls*": allow
    "cat *": allow
---
You do a fast bug sweep. Read-only; never fix anything.

Look for real defects: wrong logic, off-by-one, null/undefined paths, unhandled errors, race conditions, broken edge cases, resource leaks, security issues. Skip style nits.

Output one entry per suspected bug, most severe first:
- `path:line` — what is wrong — concrete input/state that triggers it — confidence (high/medium/low)
If nothing credible is found, say "No bugs found" and list what you checked.
```

#### `agents/bug-reviewer.md`

```markdown
---
description: Deep analysis of suspected bugs. Confirms or refutes each finding with evidence; does not fix.
mode: subagent
temperature: 0.1
permission:
  edit: deny
  webfetch: allow
  bash:
    "*": deny
    "git diff*": allow
    "git show*": allow
    "git log*": allow
    "git blame*": allow
    "rg *": allow
    "grep *": allow
    "ls*": allow
    "cat *": allow
---
You review suspected bugs in depth. Read-only; never fix anything.

For each finding in the brief: trace the actual code path, check callers and guards, and decide.
Output per finding:
- VERDICT: CONFIRMED | REFUTED | UNCERTAIN
- EVIDENCE: `path:line` quotes showing why
- TRIGGER: the concrete input/state (for CONFIRMED)
- FIX DIRECTION: one line (for CONFIRMED)
Never mark something CONFIRMED without a traced code path.
```

#### `agents/architect.md`

```markdown
---
description: Design reasoning in plain text — options, trade-offs, recommendation. Uses no tools.
mode: subagent
temperature: 0.3
permission:
  edit: deny
  bash: deny
  webfetch: deny
  read: deny
  grep: deny
  glob: deny
  list: deny
  task: deny
  skill: deny
---
You are the architect. You reason only from what the brief gives you; you have no tools.

Output:
1. The problem restated in one or two lines.
2. 2-3 viable options, each with its main trade-off.
3. A clear recommendation and why.
4. Risks and what would change your mind.
If the brief lacks facts you need, list them under "Missing facts" instead of assuming.
```

### 3.7 `oc-run.mjs`: dispatcher with model fallback

`opencode run` exits on the first model error, so the runtime-fallback plugin never replays the prompt in a headless run (verified 2026-09-26: a matching error still ended the run). The plugin still helps in the interactive TUI. For Claude Code's dispatches, this script walks each worker's chain instead: one `opencode run` per model in `[model, ...fallback_models]`, pinned via `OPENCODE_CONFIG_CONTENT` for the orchestrator and the worker, moving on after an error event, empty output, `DISPATCH FAILED`, a hard timeout (`--timeout`), or no activity for `--idle` seconds (default 480: a stuck model is dropped in minutes instead of holding the chain for the whole timeout). On Windows it reads `TOKENHARBOR_API_KEY` from the user environment when the shell doesn't have it.

```js
#!/usr/bin/env node
// Dispatch one brief through the orchestrator, walking the worker's model chain.
//
// `opencode run` exits on the first model error, so the runtime-fallback plugin
// never gets to replay the prompt in headless runs. This wrapper does the
// fallback instead: one `opencode run` per model in [agent.model, ...fallback_models],
// with that model pinned for the orchestrator and the worker, until one answers.
//
//   node ~/.config/opencode/oc-run.mjs --worker implementer --brief b.txt --out b.out.jsonl --log b.log
//     [--timeout 900]                    (hard cap per model, seconds)
//     [--idle 480]                       (move on when a model shows no activity for this long, seconds)
//     [--chain m1,m2]                    (--chain overrides the chain, for testing)
//     [--dry-run]                        (print the chain and exit)
//
// Exit 0 when a model answered (stdout names it), 1 when every model failed.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, []),
);
const worker = args.worker;
if (!worker) die("--worker is required");
const confDir = join(homedir(), ".config", "opencode");
const config = JSON.parse(readFileSync(join(confDir, "opencode.json"), "utf8"));
const agent = config.agent?.[worker];
const chain =
  typeof args.chain === "string"
    ? args.chain.split(",")
    : [agent?.model ?? config.model, ...[agent?.fallback_models ?? []].flat()].filter(Boolean);
if (!chain.length) die(`no model chain for ${worker}`);
if (args["dry-run"]) {
  console.log(chain.join("\n"));
  process.exit(0);
}
for (const k of ["brief", "out", "log"]) if (typeof args[k] !== "string") die(`--${k} is required`);
const brief = readFileSync(args.brief, "utf8");
const timeoutMs = Number(args.timeout ?? 900) * 1000;
// A stuck model otherwise holds the chain for the whole hard timeout; one that
// is working keeps writing log lines or JSON events. Long single answers can
// stream for minutes without either, so this is generous.
const idleMs = Number(args.idle ?? 480) * 1000;

const env = { ...process.env };
// A shell started before the key was set can't see it; read it from the user env (never printed).
if (!env.TOKENHARBOR_API_KEY && process.platform === "win32") {
  const q = spawnSync("reg", ["query", "HKCU\\Environment", "/v", "TOKENHARBOR_API_KEY"], { encoding: "utf8" });
  const m = /TOKENHARBOR_API_KEY\s+REG_\w+\s+(\S+)/.exec(q.stdout ?? "");
  if (m) env.TOKENHARBOR_API_KEY = m[1];
}

writeFileSync(args.log, "");
for (let i = 0; i < chain.length; i++) {
  const model = chain[i];
  const attemptOut = `${args.out}.attempt${i + 1}`;
  appendFileSync(args.log, `\n=== oc-run attempt ${i + 1}/${chain.length}: ${model} ===\n`);
  const agentOverride = { orchestrator: { model }, [worker]: { model } };
  const result = await runOnce({ ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: agentOverride }) }, attemptOut);
  const verdict = result.timedOut ? "timeout" : result.idle ? `idle ${idleMs / 1000}s` : judge(attemptOut);
  appendFileSync(args.log, `=== attempt ${i + 1} (${model}): ${verdict} ===\n`);
  if (verdict === "ok") {
    copyFileSync(attemptOut, args.out);
    console.log(`oc-run: answered by ${model} (attempt ${i + 1}/${chain.length})`);
    process.exit(0);
  }
  console.log(`oc-run: ${model} failed (${verdict}), trying the next model`);
}
writeFileSync(args.out, "");
console.log(`oc-run: all ${chain.length} models failed`);
process.exit(1);

function runOnce(childEnv, outFile) {
  return new Promise((resolve) => {
    const out = [];
    const child = spawn(opencodeBin(), ["run", "--agent", "orchestrator", brief, "--format", "json", "--print-logs", "--log-level", "INFO"], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"], // closed stdin: an open one makes `opencode run` wait forever
      windowsHide: true,
      detached: process.platform !== "win32", // its own process group, so a timeout kills nested runs too
    });
    let lastActivity = Date.now();
    child.stdout.on("data", (d) => {
      lastActivity = Date.now();
      out.push(d);
    });
    child.stderr.on("data", (d) => {
      lastActivity = Date.now();
      appendFileSync(args.log, d);
    });
    let timedOut = false;
    let idle = false;
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity < idleMs) return;
      idle = true;
      clearInterval(watchdog);
      killTree(child.pid);
    }, Math.min(15_000, idleMs / 4));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      clearInterval(watchdog);
      writeFileSync(outFile, Buffer.concat(out));
      resolve({ timedOut, idle });
    });
  });
}

/** "ok" when the run ended with a real answer; otherwise why not. */
function judge(file) {
  const events = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const error = events.find((e) => e.type === "error");
  if (error) return `error: ${String(error.error?.data?.message ?? error.error?.name ?? "unknown").slice(0, 160)}`;
  const text = events
    .filter((e) => e.type === "text")
    .map((e) => e.part?.text ?? "")
    .join("")
    .trim();
  if (!text) return "empty output";
  if (text.startsWith("DISPATCH FAILED")) return text.split("\n")[0].slice(0, 160);
  return "ok";
}

function opencodeBin() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  if (process.platform !== "win32") return "opencode";
  // The npm shim is a .cmd; run the real executable so the brief isn't re-parsed by cmd.exe.
  const root = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: true }).stdout?.trim();
  const exe = root && join(root, "opencode-ai", "bin", "opencode.exe");
  if (exe && existsSync(exe)) return exe;
  die("opencode.exe not found; set OPENCODE_BIN");
}

function killTree(pid) {
  if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)]);
  else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
}

function die(msg) {
  console.error(`oc-run: ${msg}`);
  process.exit(2);
}
```

## 4. Model tiers & routing

All Token Harbor models below passed a tool-calling test on 2026-09-26.

| Model ID (`tokenharbor/…`) | Tier | Cost |
|---|---|---|
| `deepseek-v4.1-flash:free` | Free | $0. Shared rolling 7-day free allowance, then returns 429 |
| `mimo-v2.6-flash:free` | Free | $0. Same shared allowance |
| `qwen3.8-flash:free` | Free (campaign) | $0. Separate campaign allowance |
| `glm-5.3-flash` | Agent Pass, **2× boost** | $0.15 / $0.50 per 1M in/out |
| `qwen3.8-flash` | Agent Pass, **2× boost** (limited) | $0.15 / $0.47 |
| `qwen3.7-flash` | Agent Pass | $0.03 / $0.13 per 1M in/out; the largest pass request allowance (25.6k+). Tool calling per the API listing; not yet tested here |
| `deepseek-v4.1-flash` | paid (last resort) | $0.30 / $1.20 |
| `mimo-v2.6-flash` | paid (last resort) | $0.14 / $0.28 |

Agent Pass = $10 included usage per 4 weeks, split into 7-day windows (unused room does not carry over). After that, pay-as-you-go at 5% off. **Set a per-key USD spending cap in the dashboard.**

Fallback order per agent (free → AgentRouter → Agent Pass). No GPT models:

| Agent | Primary | Fallbacks |
|---|---|---|
| orchestrator | `TH mimo-v2.6-flash:free` | `TH qwen3.8-flash:free` → `AgentRouter` → `TH qwen3.7-flash` |
| researcher | `TH deepseek-v4.1-flash:free` | `TH mimo-v2.6-flash:free` → `AgentRouter` → `TH glm-5.3-flash` → `TH deepseek-v4.1-flash` |
| implementer | `TH deepseek-v4.1-flash:free` | `AgentRouter` → `TH qwen3.8-flash` → `TH glm-5.3-flash` → `TH qwen3.7-flash` |
| bug-catcher | `TH qwen3.8-flash:free` | `TH mimo-v2.6-flash:free` → `AgentRouter` → `TH qwen3.8-flash` → `TH mimo-v2.6-flash` |
| bug-reviewer | `TH deepseek-v4.1-flash:free` | `AgentRouter` → `TH glm-5.3-flash` → `TH qwen3.8-flash` → `TH qwen3.7-flash` |
| architect | `TH deepseek-v4.1-flash:free` | `AgentRouter` → `TH glm-5.3-flash` → `TH qwen3.8-flash` → `TH qwen3.7-flash` |

Left out on purpose:

- `th-orchestra`: auto-router whose planner uses premium models, which would burn the $10 at full price.
- Claude models: not boosted on Agent Pass.
- GPT models: not used, by choice.
- TH-Rudder: not offered through the API.

## 5. Verify

Run these from `CONF`. On Windows, start the proxy first (`start-proxy.bat` or `start-opencode.bat`).

```bash
opencode models tokenharbor            # should list the 8 models
opencode run -m tokenharbor/deepseek-v4.1-flash:free "Reply with exactly: TH_OK"
opencode run -m AgentRouter-openai-gateway/deepseek-v4-flash "Reply with exactly: AR_OK"   # 13–30 s is normal
opencode run --agent orchestrator "Delegate to the researcher subagent: list the files in the agents/ directory and state which one has mode: primary. Relay only that subagent's raw output."
```

Expected: `TH_OK`, `AR_OK`, then a researcher answer naming `orchestrator.md` as primary, with `path:line` evidence.

Then check that the fallback reaches AgentRouter when Token Harbor fails (two unknown model ids stand in for exhausted ones):
```bash
node ~/.config/opencode/oc-run.mjs --worker implementer --dry-run      # prints the chain, AgentRouter last
printf 'Delegate to the researcher subagent: reply with exactly AR_OK; use no tools. Relay only that subagent's raw output.' > /tmp/b.txt
node ~/.config/opencode/oc-run.mjs --worker researcher --brief /tmp/b.txt --out /tmp/b.jsonl --log /tmp/b.log --timeout 240   --chain tokenharbor/nope-a,tokenharbor/nope-b,AgentRouter-openai-gateway/deepseek-v4-flash
```
Expected: two "failed … trying the next model" lines, then `oc-run: answered by AgentRouter-openai-gateway/deepseek-v4-flash (attempt 3/3)`.

## 6. Calling it from Claude Code

Claude Code writes the brief to a file and runs the dispatcher, one worker per call, from the project directory:

```bash
# brief file: "Delegate to the <researcher|implementer|bug-catcher|bug-reviewer|architect> subagent: <brief>. Relay only that subagent's raw output."
node ~/.config/opencode/oc-run.mjs --worker <agent> --brief .ai/tmp/x.brief.txt --out .ai/tmp/x.out.jsonl --log .ai/tmp/x.log --timeout 900
```

stdout names the model that answered (exit 0) or says every model failed (exit 1). The implementer never commits; Claude Code reviews the diff and commits.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Ran the `tokenharbor` CLI and now other tools hit Token Harbor | Windows: `foreach ($n in 'OPENAI_API_KEY','OPENAI_BASE_URL','OPENAI_API_BASE') { [Environment]::SetEnvironmentVariable($n, $null, 'User') }`. macOS: remove the lines it added to your shell profile / `~/.tokenharbor/env.sh`. Also check `~/.claude/settings.json` for `ANTHROPIC_BASE_URL` and restore it from its `.th-backup` file. |
| `tokenharbor` CLI stuck on "Verifying key…" | Don't use it; this manual setup replaces it. |
| Token Harbor 401 in OpenCode | `TOKENHARBOR_API_KEY` isn't visible. Open a new terminal, then re-run the curl check in step 2. |
| AgentRouter `ECONNREFUSED` | Proxy not running. Start it with `start-proxy.bat` / `start-proxy`. The fallback plugin skips to the next model meanwhile. |
| AgentRouter looks hung | It is sometimes slow. The plugin's 60 s timeout moves the agent on to the next model. |
| Free model returns 429 | Free allowance used up for the week. Expected; the fallback chain takes over. |
| Agents ignore their model | Run `opencode debug config` and check `agent.<name>.model`. Make sure the `agents/` folder is inside `CONF`. |
| A fallback chain takes hours | A model hung without failing. `oc-run` drops a model after `--idle` seconds with no log line or event (default 480); lower it for short briefs. |
| A headless run ends empty or on an error with no fallback | Expected for `opencode run`: the plugin can't replay there. Dispatch through `oc-run.mjs`, which walks the chain itself. |
| The implementer starts its own `opencode run` (a nested process, work missing from the log) | It read a repo's CLAUDE.md delegation section. `agents/implementer.md` denies `opencode*` and says it never delegates; keep both. |
| Undo | Delete the `tokenharbor` provider and the `agent` block from `opencode.json`. |
