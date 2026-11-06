# Handoff 2: continue on another machine

Read this first, then `HANDOFF.md` (state, next steps, traps). Written 2026-11-06 on the Mac.

## What lives where

| Thing | Where | In git? |
|---|---|---|
| Docs, `HANDOFF*.md`, `design_plan.md`, `design_mode_mock.html` | branch `m4` (main checkout `aiharness/`) | yes |
| Design v2 code | branch `track/design-v2` (worktree `aiharness-wt/design-v2/`) | yes |
| Plan `design-mode-v2.md`, the archive, research notes, evals | `aiharness/.ai/` | **no** (git-ignored): in the zip |
| Live-test scripts `kit-tools/`, `kit-release/` | `aiharness-wt/design-v2/.ai/` | **no**: in the zip |
| Journey driver and reference image | — | in the zip, `scratch/` |
| Claude's memory notes | `~/.claude/projects/<encoded repo path>/memory/` | in the zip, `claude-memory/` |
| The reference screen recording (2026-11-05, 13 MB) | Mac Desktop | in the zip, `reference/` |

Zip: `cubiq-ai-folders-2026-11-06.zip` (20 MB). Left out: `.ai/reports` (284 MB of old reports) and `kit-tools/look` (screenshots).

## Set up at home

Run in the folder that holds `aiharness/` (the zip's paths start there).

1. Main checkout:
   ```
   cd aiharness
   git fetch origin
   git checkout m4
   git pull
   ```
2. Worktree for the code (beside `aiharness/`, as on the Mac):
   - If there's no worktree yet: `git worktree add ../aiharness-wt/design-v2 track/design-v2`. If git says the branch doesn't exist locally: `git worktree add ../aiharness-wt/design-v2 -b track/design-v2 origin/track/design-v2`.
   - If the worktree already exists: `cd ../aiharness-wt/design-v2`, then `git pull`.
   - Then, inside the worktree: `bun install`, then `node node_modules/electron/install.js`.
3. Unzip in the parent folder. `aiharness/.ai/…` and `aiharness-wt/design-v2/.ai/…` land in place. Put `scratch/` and `reference/` anywhere (a scratch folder).
4. Memory: copy `claude-memory/*.md` into `~/.claude/projects/<this machine's encoded repo path>/memory/`. The folder name is the repo path with `/`, `\` and `:` turned into `-` (open Claude Code once in the repo to have it created). Merge: if a note with the same name already exists there, compare the two before overwriting it.
5. Check, in the worktree: `bun run typecheck`, `bun run test`, `bun run design:check`. All three passed on the Mac at `7b68985` (4508 tests).

## Heads at hand-off

- `track/design-v2`: `7b68985` (the `design-kit` skill), on top of `d73f57a` (M6 slice 4).
- `m4`: this file plus the `HANDOFF.md` update.

## Live testing on the new machine

The Mac's scratch profile and its journey threads don't come along. To rebuild them:
1. Start the app with a fresh profile (see `HANDOFF.md` → Live testing).
2. Install the kits into the profile (same section).
3. Create the threads with `scratch/j-setup.mjs`.
4. Write the pages with `kit-tools/kit-page.ts`: Foundation for J-F, `shadcn-ui` for J-G, `mantine` for J-I.
5. Run `scratch/journey.mjs <D|F|G|I> <threadId> <outPrefix>`, with `MODEL=PGA/deepseek-v4.1-flash-1017` or another allowed model.

**Fix paths first:** `kit-page.ts` and the `scratch/*.mjs` scripts hold absolute Mac paths (`/Users/phumrin/…`, `/private/tmp/claude-501/…`); point them at your paths. On Windows, use the shell's own timeout (there's no `perl alarm`) and the Windows Chrome path for `agent-browser`.

**Models:** OpenCode Zen's free DeepSeek hit **"Free usage limit reached"** on 2026-11-06. Use PGS Grove (`PGA/deepseek-v4.1-flash-1017`); Codex and Claude Sonnet are also allowed for the journeys.

## Picking up

`HANDOFF.md` → "Next, in this order", item 6 (M6 slice 5). The D re-run on PGS Grove saved a kit but kept the default name and barely used kit parts (see `HANDOFF.md`), so D doesn't pass yet. Then F, G4 and I, then M7 and M8.
