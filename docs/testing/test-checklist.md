---
e2e-target:
  base_url: http://localhost:5173
  cdp: http://127.0.0.1:9466
  environment: local isolated Electron
  roles:
    local: {}
  skip: [credential-management, login, external-oauth, windows-native-on-macos]
  test_data_prefix: E2E-DesignV2
---

# Design-mode live verification — P0–P5

**State: pending; no live checks or acceptance passes recorded.** Complete the manual instance gate below before `discover` or `setup`, then verify the actual renderer URL with `discover`; Vite may choose another port. Use only the isolated local app and approved test threads. Do not open credentials, external profiles, settings exports, or auth flows.

Reference: [original P0 qualitative baseline](../../.ai/plans/design-mode-baseline.md). Its historical Full-permission run is a visual comparison, **not** permission evidence for this Ask-mode run. Do not invent numeric P0 slop/lint counts.

## Mandatory manual instance gate — pending

The main operator must complete these checks **before `discover`/`setup`**; this one-off runner has no automatic instance binding.

- [ ] **Before each launcher invocation**, verify that CDP port `9466` has no listener. If occupied, stop; do not reuse or terminate an unrelated instance.
- [ ] After launch, identify the **actual Electron PID listening on CDP 9466**, not the Node PID printed by the launcher. Manually confirm its arguments contain exactly `--user-data-dir=/var/folders/bg/702ybqv14yv94_mflvq_tjwm0000gn/T/opencode/aiharness-design-live-20261023/ud`. Do not inspect the data directory or unrelated processes; do not copy full commandlines or environment into evidence.
- [ ] On the **same pinned renderer/CDP target**, inspect only the projected `aboutInfo().commit` and require **`c3d83e3`**. A missing/different commit or uncertain listener identity blocks discovery/setup.
- [ ] Repeat the listener identity, isolated argument and same-target commit checks after **every reconnect or restart**; repeat the empty-port check before every new launch. Record only the listener PID, boolean confirmations and commit, never arbitrary process commandlines.

## Baseline matrix — pending

Run each exact prompt in a fresh default **Design / Auto / Ask** thread on each provider. Do not force a style or tier, append instructions, or silently substitute a model.

| Provider | Required model | State |
|---|---|---|
| Claude | `sonnet` | Pending, 10 prompts |
| Codex | GPT-6-Luna, **exact ID returned by discovery** | Pending, 10 prompts |
| OpenCode | `opencode/deepseek-v4.1-flash-free` | Pending, 10 prompts |

The thread's requested agent/model must stay exact. Only Claude's requested `sonnet` alias may appear in `turn-start` as `sonnet` or an ID matching `/^claude-sonnet-\d+(?:-\d+)*$/`. Record requested and actual resolved models separately; other agents/families, unrecognized suffixes and generic substitutions remain blocked.

1. Landing page, note-taking app
2. Pricing card, pro plan
3. Mobile login
4. Analytics dashboard
5. Docs page, CLI install
6. Photographer portfolio
7. Pitch deck, coffee
8. Settings, team chat
9. Game main menu
10. Finance app home

## Acceptance — all pending

- [ ] Per provider: at least **6 distinct styles** across the ordered ten prompts; no adjacent duplicate style. Record direction/style and screenshots per thread, not just an aggregate claim.
- [ ] Auto chip appears on fresh threads and reflects the chosen direction; default tier is not overridden by the runner. Thread agent/requested model stay exact, and the separately recorded actual turn model satisfies the narrow resolution rule above.
- [ ] Ask stays enabled. **No design-folder write permission cards**, including during temporary/atomic writes and More styles. Other permissions need an explicit, individually reviewed manual decision; never auto-approve. A permission observation gap blocks a zero-card claim.
- [ ] Qualitatively less repeated slop than P0 (eyebrows, dot-separated metadata, hero metrics, identical card grids); no new contrast or target-size regressions. Visual judgment needs screenshots/human review. If lint evidence is needed, send a **separate lint-only follow-up after capturing the unchanged baseline**; there is no public `designLint` IPC.
- [ ] More styles yields **three labeled variants**; compare, promote one, and verify the promoted main page. Record the separate turn and chosen label; no baseline prompt edits.
- [ ] Temporary writes do not cause a premature/blank preview or false completion. Final file changes update the canvas; running beam follows actual running/terminal state and respects reduced motion.
- [ ] Codex ordering: for the same file-change item, **`item/started(fileChange)` occurs BEFORE `item/fileChange/requestApproval`**. Record sanitized sequence/metadata evidence; style selection before writes is not a substitute for this criterion. If the public monitor cannot establish this adapter-specific order, leave it manual/pending. Preview updates and terminal turn-end must also remain coherent; an empty running list is not completion evidence.
- [ ] Dark and light themes; narrow window (900px with panel open); ordinary chat regression; Tab order, visible focus, overlay Escape/return focus. Check loading/empty/error states, readable contrast and usable targets without changing tokens or layout to accommodate the test.
- [ ] **Windows native: manual / pending on Windows**, never inferred from macOS. Include native chrome/insets, opaque sidebar, paths and permissions.

## Evidence / report — pending

Tooling: `.ai/tmp/design-live-20261023/{launch.mjs,live.mjs,prompts.json}`. Run `live.mjs help`; commands are serialized. `setup` creates ten fresh threads and selects/reloads the first. `select` checkpoints before reloading. `send` persists its baseline sequence before dispatch and returns early; poll `status` until a matching terminal **turn-end after that baseline**, not merely `running: false`. Do not resend to repair missing evidence.

Inert tooling check: `node .ai/tmp/design-live-20261023/live.mjs self-test`. It uses synthetic literals only to check prefixed credential-assignment redaction, harmless model paths/thread IDs and the strict model-resolution rule; it does not read files, inspect processes, connect to the browser or call models. It is not live acceptance evidence and needs no instance gate.

Only manifest-owned threads are actionable. Reports go to `.ai/reports/design-live-20261023/`: manifest (IDs/model/exact prompts), per-thread sanitized checkpoints/statuses and explicitly named screenshots. JSON/checkpoints contain no settings, credentials, reasoning, assistant text or raw tool payloads; runtime logs are discarded. Inspect screenshot pixels before sharing: text guards cannot redact image/frame content. If anything secret-like is found, stop and hand review to the main operator, not a worker.

Stored events can be rehydrated after reload; live-only permission/design-change events in a renderer gap cannot. Keep the selected thread visible and checkpoint before intentional reloads. Mark gaps, redactions, unavailable models, startup failures and absent terminal events **blocked/pending**, never passed. The detached launcher prints a PID but discards stdout/stderr; verify actual readiness through the browser.

For each result record: provider + exact requested model + actual resolved turn model, prompt number, thread ID, observed direction/style, permission observations and coverage, terminal sequence/usage, screenshot path, verdict (`pending`, `pass`, `fail`, `blocked`, `manual`) and a short defect/review note. Preserve the baseline capture before follow-ups. **Current report: all pending; runtime evidence not yet collected.**
