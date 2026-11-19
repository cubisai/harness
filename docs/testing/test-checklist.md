# CubiQ focused E2E checklist

## e2e-target

```yaml
base_url: http://localhost:5173/
environments: local Electron (renderer 5173, main over IPC, automation CDP 9477)
roles:
  user:
    authentication: existing CubiQ profile and user-connected Posara MCP; never export credentials
skip: [production-writes, refunds, inventory-updates, oauth-relogin, login-negative-tests, viewport-emulation-on-user-window]
test_data_prefix: e2e-test-
```

The target is the real Electron window, not a browser opened on the renderer URL (that browser has no preload). Connect the named automation session to CDP 9477. Do not create a new browser tab or change the user's viewport. Inspect only the saved connector overview/tool metadata and read-only results; never read clipboard or raw secret/config files.

## Phase 0 — Creator / Posara smoke

Scope: approved Creator v2 phase D; `HANDOFF.md` and `.ai/plans/creator-v2.md`. Preserve all existing apps, threads and connector data. Install/Update cards remain user-approved. Local, user-requested dashboard artifacts are not disposable production test records; record their IDs and leave them unless the user asks to remove them.

| ID | Check | Expected | Status |
| --- | --- | --- | --- |
| D-01 | Real window and preload | CubiQ loaded, no blank/crashed renderer | Pass |
| D-02 | Posara connector | Saved and connected in the correct scope | Pass |
| D-03 | Tool metadata and read shape | Actual read-only tools/schemas/data; no mutating calls | Pass |
| D-04 | Creator build turn | Dedicated Creator thread builds a draft against actual schemas | Pass |
| D-05 | Preview/check | Working app, no console/bridge errors, no fabricated data | Pass; BUG-D-1 fixed and user-updated |
| D-06 | Review/install | Explicit user Install; global app appears without restart | Pass |
| D-07 | Filters and refresh | Date controls/refresh use appropriate connector arguments | Pass; all presets, mouse/keyboard Refresh |
| D-08 | Empty/error states | Clear empty/error text and retry; no production mutations | Pass; live empty/populated, isolated error/Retry |
| D-09 | Edit/Update | Separate draft, successful check, explicit user Update | Pass; open global pane reloaded without restart |
| D-10 | Themes and keyboard | Both themes, reachable controls, visible focus | Pass; light/dark, 2px focus, Tab/Enter |
| D-11 | Layout | No horizontal overflow at the user's current window size | Pass at native 1280px; no user-window emulation |
| D-12 | Data safety | No secret exposure, no modification of shop data | Pass; only sales-summary/settings reads, one app grant |

Earlier mock runtime/build/update checks are recorded in the Creator B/C local plans. This run must use Posara, not silently substitute fixture data. Evidence and the run report go under ignored `test-output/creator-posara/` and `test-output/report.md`; do not commit real shop data or screenshots.

## Creator E — isolated page themes and scheduled prompts

This is a **separate fixture run**, not a replacement for the real Posara checks above. Use a separate profile/project and CDP port (this run: 9489). Never target 9477 or emulate the user's window. The user approved fixture Install/Update/Uninstall and one tool-free Codex Run now. Keep schedules disabled; no connector or production calls.

| ID | Check | Expected | Status |
| --- | --- | --- | --- |
| E-01 | Theme preview | Isolated script-free/no-network light/dark specimen; no install or page change | Pass; shared scaled specimen |
| E-02 | Theme install | Project-only, user-reviewed; appears in existing Design Style picker | Pass |
| E-03 | Theme application | User explicitly applies; page structure stays unchanged, existing Undo is available | Pass; fixture only; Undo execution not separately checked |
| E-04 | Theme update protection | Added/changed/missing files are never discarded | Pass; unit cases and visible live added-file failure |
| E-05 | Theme update | Owned update changes saved theme, not the already-applied design copy | Pass |
| E-06 | Automation install | Project-only custom prompt, Off/Ask, zero runs/model turns on Install | Pass |
| E-07 | Explicit Run now | One fresh Ask thread, tool-free result, no schedule enabled | Pass; Codex fixture run |
| E-08 | Automation update | Same owned ID, existing history retained, updated settings still Off/Ask | Pass |
| E-09 | Automation safety | Manual collisions, modified settings, active runs and failed recording protected | Pass; unit cases |
| E-10 | Uninstall | Confirmed removal only of owned fixtures; active page copy remains | Pass; 0 automation rows/owned installs, page copy retained |
| E-11 | UI quality | Light/dark/system, 900px with panel, keyboard/focus, reduced motion, scoped accessibility | Pass on macOS; 0 violations/incomplete in both final card audits |
| E-12 | Regressions | Existing skill/connector scopes and global-only Apps preserved | Pass; full suite |

Windows CI and model-led Creator authoring of these two proposal kinds were not covered by the original fixture run. The authorized continuation below now covers model-led authoring and actual theme Undo. Windows remains pending. Evidence belongs in ignored local QA output, not public screenshots of a user's profile.

### Model-led E continuation — 2026-11-18

Separate scratch profile/project/CDP **9490**, loopback built renderer **5189**, real native 900×700 window. User approved authoring, then the diagnosed attachment fix, then Install both → sample-page Apply → Undo → Uninstall both. Never Run now or enable. Original E fixture results and the Posara profile were not changed.

Initial attachment attempts stopped before a turn. Diagnosis confirmed that fresh-session `--pin-tab` intentionally creates a tab; Electron rejects it. Attach unpinned, select the exact existing main target, then pin. HTTP serving alone was not the fix. Named session `creator-e-authoring-http`, explicit CDP 9490 on UI commands; scratch app/session/server stopped at close.

| ID | Check | Status |
| --- | --- | --- |
| E-M01 | Model-led theme and automation proposals | Pass; exactly one Codex default/Medium Ask turn, 8 allowed Creator tool calls, no errors/permission/questions/shell/connector calls |
| E-M02 | Model-invoked light/dark theme previews | Pass; both PNG results read; interactive Style picker scales its specimen; no claim of full offscreen-sample responsiveness |
| E-M03 | Staging has no install/run side effects | Pass; 2 proposals, 0 installs/automations/runs |
| E-M04 | User-approved Install both | Pass; project-only; theme changes no page; automation Off/Ask, lastRun/nextAt null, zero runs |
| E-M05 | Explicit Apply and actual keyboard Undo | Pass; ⌘Z restores Foundation and every system-file hash; page HTML unchanged |
| E-M06 | Confirmed cleanup / active copy safety | Pass; Escape cancels; both owned installs removed; 0 installs/automations/runs; restored sample retained |
| E-M07 | Light/dark 900px and keyboard | Pass; no window/card overflow, 2px ink focus/2px offset, Library Escape restoration; scoped card axe 0 violations/incomplete each; errors empty |
| E-M08 | Fresh gates | Pass; build/typecheck; 4,829 tests/10 skipped; design check 0 errors/48 existing doc warnings |

Evidence: ignored `.ai/tmp/creator-e-authoring/report.md`, `authored-evidence.json`, `installed-state.json`, `page-{applied,undone,after-uninstall}.json` and `final-state.json`. The completed authoring thread must **not** be replayed. Windows/CI, new automation runs and model-generated E Updates were not performed; existing fixture Update/Run results remain unchanged.
