# Rollback: triggers and drill

How to decide whether to roll back from the M4 release to Milestone 3 behaviour, and how to rehearse it on a test machine. Phase 9 T9.5 and T9.12; the reasoning is in [06-roadmap.md](06-roadmap.md) §6.6–6.7.

## Triggers

Roll back if any of these fires. They are computed on the user's machine; nothing is reported anywhere (T9.4: the app has no telemetry).

1. **A subscription login is downgraded silently.** Any provider path that switches an agent from the user's own sign-in to a key, or drops features, without saying so in the thread. The injection contract surfaces every such change as a notice (spec invariant 7); a silent one is a release blocker.
2. **A config backup or restore fails on any platform.** One failing platform is enough; it is not a platform bug to fix later. In this build, M4 writes no agent config outside its data folder: Codex gets its provider as `-c` overrides and a catalog in the data folder, OpenCode gets its config in `OPENCODE_CONFIG_CONTENT`, and Claude gets environment variables. So the check is that `~/.codex/config.toml`, OpenCode's config and Claude's settings are **byte-identical** before and after (drill step 2).
3. **The cache hit rate regresses.** The cumulative cache-read hit rate over the 7 days after the M4.5 release is more than **5 percentage points** below the 7 days before it: `hitRate(M4.5) − hitRate(M3) > −0.05` must hold. Separately, unexpected cache misses (a changed prefix with no compaction, TTL expiry or session rebuild behind it) must stay at or below **1% of turns**. The cumulative rate is `Σ cacheRead / Σ (cacheRead + cacheWrite + net-new input)`, not the mean of per-turn rates (`cumulativeHitRate`, `hitRateRegression` and `prefixStability` in `src/main/cache-policy.ts`).

**The baseline needs data.** Milestone 3 never stored cache fields; Phase 0 started recording them in each `turn-end`. Trigger 3 has something to compare against only if a build with Phase 0 ran for at least 7 days before the M4.5 release. Without that, `scripts/rollback-check.mjs` reports NO DATA and trigger 3 cannot fire. Say so in the release notes rather than treating silence as a pass.

## Drill

Run it on a test machine with a copy of a real data folder (Settings → Data & Security → Open Data Folder shows it; `AI Harness` under `%APPDATA%`, `~/Library/Application Support` or `~/.config`).

1. **Export.** In the M4 build: Settings → Data & Security → **Export Settings…**, and ⌘K → **Export Thread…** for two threads, one that has switched agents and one that hasn't. Quit the app and copy the whole data folder aside as well.
2. **Hash the agent configs** (trigger 2): `~/.codex/config.toml`, `~/.config/opencode/opencode.json` (or `opencode.jsonc`), `~/.claude/settings.json`. On Windows, `certutil -hashfile <file> SHA256`; elsewhere `shasum -a 256 <file>`. Compare with hashes taken before the M4 build first ran; they must match.
3. **Downgrade.** Run the last Milestone 3 build against the same data folder (`git checkout main && bun install && bun run dev`, or the M3 release). It must start, list every project and thread, and open their events: its migrations stop at its own last step, and it names its columns, so M4's extra columns and tables are ignored (`test/bindings-rollback.test.ts` proves this with a frozen copy of the M3 `Store`).
4. **Check what M3 relies on.** Open a thread that had a Claude session and send a message: it resumes, because M4 keeps `threads.session_id` mirroring the current agent's cursor. Settings → API keys still shows the keys set: M4 never rewrites `secrets.*` (the provider migration copies them, byte for byte).
5. **Upgrade again.** Quit M3 and start M4. The thread you continued in M3 resumes the session M3 used: when `session_id` disagrees with the binding, M4 takes the column, since only an older build writes it alone. Import one of the thread exports from step 1 into a project: it opens with its events and, for an export made before bindings existed, its session cursor.
6. **Check the numbers.** `node scripts/rollback-check.mjs --since <M4.5 release date>` (add `--db <path>` for a copied data folder) prints both windows' hit rates, the delta and PASS/FAIL against −5 pp.
7. **Restore settings if needed.** Settings → Data & Security → **Import…** with the file from step 1 puts back providers, which agent uses which, and preferences. Keys in an export are ciphertext only this machine and user account can open; on another machine, enter them again. The Antigravity opt-in is never carried over: it is acknowledged per install.

A reviewer who has run steps 1–7 on a test machine signs off in the release checklist with the platform and date. One failure on any platform is trigger 2.
