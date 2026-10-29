# CubiQ: practical plan for a full Rust migration

**Status:** researched proposal, not an implementation or a claim that migration tests have passed.

**Research checked:** 22 October 2026. Recheck releases before starting implementation.

**Scope:** the CubiQ application in this repository, currently packaged as `aiharness` version `0.1.2`.

**Goal:** move first-party application services and UI logic to stable Rust without quietly dropping existing features, changing the design, or losing user data.

## Contents

1. [Bottom line](#1-bottom-line)
2. [What a full port means](#2-what-a-full-port-means)
3. [What this application actually contains](#3-what-this-application-actually-contains)
4. [Latest verified Rust and Tauri baseline](#4-latest-verified-rust-and-tauri-baseline)
5. [Target architecture and UI choice](#5-target-architecture-and-ui-choice)
6. [Feasibility gates: prove these first](#6-feasibility-gates-prove-these-first)
7. [Module-by-module replacement map](#7-module-by-module-replacement-map)
8. [Runtime, contracts, and concurrency rules](#8-runtime-contracts-and-concurrency-rules)
9. [Implementation phases](#9-implementation-phases)
10. [Data migration and rollback runbook](#10-data-migration-and-rollback-runbook)
11. [Security requirements](#11-security-requirements)
12. [Tests, platform QA, and performance](#12-tests-platform-qa-and-performance)
13. [Packaging and upgrades](#13-packaging-and-upgrades)
14. [Effort, risks, and decisions](#14-effort-risks-and-decisions)
15. [First ten working days](#15-first-ten-working-days)
16. [Completion checklist](#16-completion-checklist)
17. [Research sources and limits](#17-research-sources-and-limits)

## 1. Bottom line

**Yes, a Rust-owned CubiQ is a realistic target. Tauri is a reasonable desktop host, but switching Electron to Tauri is only part of the job.**

The recommended destination is:

- **Rust application runtime:** agents, provider requests, tools, permissions, storage, Git, MCP, memory, teams, learning, and scheduling.
- **Leptos Rust/WASM UI:** the current web-shaped interface, rebuilt in Rust while retaining its CSS, local fonts, design tokens, and interaction behavior.
- **Thin Tauri 2 desktop host:** window lifecycle, dialogs, menus, native integration, narrowly scoped IPC, packaging, and updates.
- **An explicitly selected browser engine:** likely Chromium/CEF for the existing browser automation pane and HTML rendering. This is a feasibility gate, not an already solved Tauri integration.
- **Isolated Rust workers:** Office parsing and the JavaScript `run_code` engine should not run untrusted native parsing inside the trusted application service.

The two biggest questions must be answered before a large rewrite:

1. **Can we preserve the embedded Chromium browser experience on Windows, macOS, and Linux without Electron?** Tauri's normal system webviews are not interchangeable with Electron's cross-platform Chromium/CDP implementation.
2. **Can a Rust host preserve the existing Claude integration, including approvals, hooks, questions, session recovery, model/context information, and subagents?** Launching `claude -p` and receiving text does not establish that parity.

Default recommendation: fund a **timeboxed feasibility stage**, then commit to the architecture. Do not delete Electron or rewrite every component before those results exist.

### The practical tradeoff

Rust should make runtime ownership, cancellation, type checking, and native integration more explicit. It may reduce some application overhead. It will not make model requests faster, make Chromium small, or eliminate the work of supporting three operating systems.

If preserving the browser requires shipping CEF, the finished application may still carry a substantial Chromium dependency. A Tauri UI plus CEF pane can even mean two webview engines. **Measure the whole process tree; do not promise a smaller installer or lower RAM usage before measuring it.**

## 2. What a full port means

Use an explicit definition so a halfway migration is not mistaken for completion.

| Destination | What it achieves | Is it this plan's completed port? |
|---|---|---|
| Tauri + current React UI + Node application sidecar | Replaces some Electron hosting; retains most current language/runtime dependencies | No |
| Tauri + React UI + Rust application runtime | Rust backend, existing first-party JavaScript/TypeScript interface | Useful milestone, not final |
| Tauri + Rust/WASM UI + Rust application runtime | Rust-authored services, state handling, and UI components | Recommended endpoint, subject to declared engine/bridge dependencies |
| Rust native-rendered UI + Rust runtime | Avoids the main DOM UI; still needs browser/rendering facilities for existing features | Alternative, with a larger UI parity risk |
| Every dependency written in Rust; no JavaScript execution | Would exclude Chromium/CEF, SQLite, QuickJS, and existing generated-page/script features | Not a realistic feature-preserving interpretation |

### Final ownership policy

First-party business logic must end up in Rust. This includes logic currently in `src/main`, `src/shared`, renderer state, and runtime-used evaluation code. A Node SDK wrapper, Office conversion service, or TypeScript scheduler is not a permanent loophole.

First-party UI components and presentation state should end up in Rust/WASM. Retaining React permanently changes the objective to a hybrid port.

**Rust/WASM still ships web assets and generated JavaScript glue.** Browser APIs and Tauri IPC need bindings. Page inspection and design editing also currently execute small scripts in a page context. Inventory those helpers separately:

- Prefer generated bindings or narrowly reviewed host bridges.
- Do not put orchestration, storage, authorization, or provider logic in a bridge.
- Record any handwritten page-context JavaScript honestly. If “all first-party source must be Rust” is a hard requirement, this needs a separate generation/WASM-in-page design and proof; it is not automatically solved by choosing Leptos.
- Third-party xterm.js or Mermaid may be accepted exceptions only through an explicit decision. They do not count as fully Rust-authored terminal/diagram rendering.

The honest final claim is **“Rust application runtime and Rust/WASM UI, with declared external engines and host bindings,”** not “there is no JavaScript or C/C++ anywhere.”

### Dependencies that may legitimately remain

| Dependency class | Why it remains | Required ownership |
|---|---|---|
| Claude, Codex, ACP/OpenCode executables | External agent implementations and their own sessions/authentication | Supported-version policy, protocol fixtures, installation diagnostics |
| Git and user-selected shells/editors | Existing system integrations | Argument safety, capability checks, process supervision |
| System webview and/or Chromium/CEF | DOM UI, arbitrary-site browsing, screenshots, PDF export | Packaging, security updates, sandbox verification, licenses |
| SQLite | Existing durable database | Engine version, compile options, migration/backup tests |
| QuickJS | Product intentionally accepts JavaScript in `run_code` | Limits, isolation, broker authorization, cancellation |
| Optional PDFium or other native libraries | Existing-PDF display/rasterization if required by the chosen host | Native binary maintenance and notices |
| Skill assets and scripts | Existing user/bundled skill ecosystem | Inventory supported runtimes and keep external script dependencies visible |
| Build/test tooling | Transitional Vite/Vitest or desktop automation tooling | Development-only; not a hidden production runtime |

### Non-goals

- No UI redesign. Preserve `DESIGN.md` and existing component responsibilities.
- No new cloud service, production browser-hosted app, mobile app, or background daemon.
- No new native Gemini agent just because a Rust HTTP client can call Gemini.
- No replacement of external agents with an invented universal agent loop.
- No data-model rewrite, new database, or new approval policy bundled into the language migration.
- No automatic access to credential files, personal browser profiles, or live user sessions during research or implementation verification.

## 3. What this application actually contains

### Observed stack

These versions are **declared in `package.json`**, not a claim that every resolved dependency or embedded engine was audited.

| Area | Current declared stack |
|---|---|
| Product/build | CubiQ `0.1.2`; package `aiharness`; Bun `1.4.2`; MIT application license |
| Desktop | Electron `44.4.5`, electron-vite `5.0.0`, electron-builder `26.15.3` |
| UI | React/React DOM `19.3.0`, Zustand `5.0.15`, TypeScript `5.9.3`, Vite `7.3.6` |
| Agent/provider integration | Claude Agent SDK `0.3.281`, Anthropic SDK `0.128.0`, CLI protocol adapters, first-party HTTP/SSE loop |
| MCP/validation | MCP TypeScript SDK `1.30.1`, Zod `4.6.5` |
| Terminal/script execution | node-pty `1.1.0`, xterm `6.0.0`, QuickJS-Emscripten `0.32.0` |
| Document/archive handling | Mammoth, SheetJS `0.20.3`, JSZip |
| Tests | Vitest `4.1.11`, fake agent/MCP/OAuth servers, legacy database fixtures, packaged smoke paths |

Evidence: [package.json](package.json), [electron.vite.config.ts](electron.vite.config.ts), [electron-builder.yml](electron-builder.yml), and [CI](.github/workflows/ci.yml).

### Current topology

```text
React components + Zustand
          |
window.unskilled, exposed by the sandboxed Electron preload
          |
Electron main: composition root, IPC, windows, native facilities
          |
Service: application operations, deliberately without Electron imports
          +-- SQLite, blobs, files, settings, JSONL sessions
          +-- Claude SDK -> Claude Code executable
          +-- Codex app-server -> shared JSON-RPC process
          +-- ACP/OpenCode -> agent processes
          +-- saved providers -> CubiQ HTTP/SSE agent loop
          +-- local MCP server, remote gateway, OAuth
          +-- browser guest + Chromium CDP
          +-- hidden design rendering window; Office utility process
          +-- PTYs, shells, Git/worktrees
          +-- skills, memory, experts/teams, learning, automations
```

The useful existing boundary is `Service`, not Electron's window. Its comment explicitly describes an Electron-free application API: [src/main/service.ts](src/main/service.ts), lines 93–153. The frontend contract is mapped in [src/preload/index.ts](src/preload/index.ts), lines 4–156, with shared types in [src/shared/types.ts](src/shared/types.ts).

### Feature inventory that must survive

| Feature area | Existing source anchor | Migration obligation |
|---|---|---|
| Projects and folderless Chats | `src/main/service.ts`, renderer `App.tsx` | Project CRUD, per-chat scratch directories, relocation, defaults |
| Threads and history | `src/main/db.ts`, `service.ts`, renderer `store.ts` | Pins/archive, queued messages, history paging, totals, running/pending state |
| Agent switching | `service.ts`, `handoff.ts`, shared bindings | Handoff/fresh/back, per-agent cursors, lost-session reseeding, trust changes |
| Approvals, plans, questions | `agents/types.ts`, `service.ts`, agent adapters | Correct approve/deny scope, plan transitions, questions, interruption |
| Provider agents | `src/main/harness/`, `providers.ts` | Existing wire formats, tools, models, context, probes, usage/pricing |
| Skills and Library | `src/main/skills/`, bundled `resources/skills/` | Discovery precedence, disabled/shadowed entries, delivery modes, details |
| MCP and OAuth | `src/main/mcp/`, `mcp-http.ts` | Local tools, remote transports, routing, secrets, PKCE, reconnection |
| Browser | `src/main/browser/`, `BrowserPanel.tsx` | Embedded browsing, CDP tools, persistence, picking, logs, takeover |
| Design workspace | `src/main/design/`, `DesignCanvas.tsx` | Pages/variants, comments, drawings, references, edits, versions, export |
| Artifacts and files | `artifacts.ts`, renderer `ArtifactPanel.tsx`/`Inspector.tsx` | Contained reads, previews, source/diff/version views, editor integration |
| Git/worktrees | `git.ts`, `worktree-review.ts` | Thread worktrees, review, commit, merge/squash, push, safe removal |
| Terminal/background shells | `terminal.ts`, `shells.ts`, `TerminalPanel.tsx` | Real PTY behavior, output cursors, resize/input, stop, tree cleanup |
| Memory | `src/main/memory/` | Project/global notes, import, enable switches, frozen session snapshots |
| Experts and teams | `src/main/experts/` | Catalog/import, private skills, member models, messaging, result files |
| Learning and replay | `src/main/learn/`, `evals/` | Opt-in scoring, lessons, budgets, replay, holdout safeguards, retirement |
| Automations/Message Center | `src/main/automations/` | Timezones/DST, missed-run policy, leases/cursors/deliveries, results |
| Rich replies | `src/renderer/src/genui/`, renderer Markdown code | Validated interactive blocks, diagrams, highlighting, links/images |
| Diagnostics/desktop | `doctor/`, `updater.ts`, `src/main/index.ts` | CLI discovery/fixes, settings, splash, About, updates, native behavior |

`evals/` is not all disposable developer tooling: learning replay imports evaluation functionality through `src/main/learn/verify-app.ts`. Port its runtime dependencies too.

### Source wins when documentation is stale

- Historical provider-injection plans do not describe the current saved-provider architecture. `spec/README.md` explicitly supersedes that design.
- The UI uses locally bundled Geist fonts; do not copy an older “system fonts” description as the baseline.
- `DESIGN.md` mentions a macOS Quick Look PPTX path, but the inspected Office implementation extracts slide text/images. Verify the actual runtime before promising a native slide renderer.
- The standalone UI preview installs a mock backend. It is not an existing production web deployment.
- Automations are driven by the desktop process; tray/daemon behavior is not automatically an existing feature.
- The current automation USD budget is evaluated from turn usage totals. It is not established as a strict pre-spend ceiling.

Minimum OS releases, shipped CPU architecture coverage, actual installed SQLite/Chromium versions, current signing status, and full-suite results were not established by this research.

## 4. Latest verified Rust and Tauri baseline

### Release snapshot

| Component | Verified stable baseline | Release evidence |
|---|---|---|
| Rust compiler | **1.99.1** | Rust release announcement, 15 October 2026 [R1] |
| Rust edition | **2024** | Stabilized with Rust 1.85; editions are separate from compiler releases [R2] |
| `tauri` runtime crate | **2.12.5** | crates.io and tagged GitHub release, 21 October 2026; MSRV 1.90 [T1] |
| `tauri-build` | **2.7.4** | crates.io, 21 October 2026; MSRV 1.90 [T2] |
| Rust `tauri-cli` | **2.12.4** | crates.io, 21 October 2026; MSRV 1.90 [T3] |
| npm `@tauri-apps/cli` | **2.12.4** | Public npm `latest` metadata checked 22 October [T4] |
| npm `@tauri-apps/api` | **2.12.4** | Public npm `latest` metadata checked 22 October; package release 14 October [T5] |
| Leptos UI candidate | **0.8.22** | Published 5 October 2026; selected CSR baseline, not proof of CubiQ compatibility [L1] |

**Do not assign one version to every Tauri package.** Runtime/API currently share minor `2.12`, with different patch versions. Build helpers and plugins are independently versioned. Where both Rust and npm plugin bindings are used, follow the plugin's matching-version requirements [T6].

An earlier research snapshot found Tauri `2.12.4`; direct revalidation found the 21 October `2.12.5` release. The ecosystem index can lag. The repository-wide GitHub “latest” endpoint also returned a `3.0.0-alpha` tag in research despite misleading release metadata. **A SemVer alpha is not stable.** Use stable registry metadata, reject prerelease suffixes/yanked packages, and cross-check tagged releases.

### Proposed pinning policy

This is an example for future implementation; these files are not being added by this plan.

```toml
# Proposed rust-toolchain.toml
[toolchain]
channel = "1.99.1"
profile = "minimal"
components = ["rustfmt", "clippy"]
targets = ["wasm32-unknown-unknown"]
```

```toml
# Illustrative manifest entries, not a complete compiled workspace
[package]
edition = "2024"

[dependencies]
tauri = "=2.12.5"

[build-dependencies]
tauri-build = "=2.7.4"

# In the separate WASM UI package, not the native runtime:
# leptos = { version = "=0.8.22", features = ["csr"] }
```

- Commit the application `Cargo.lock` and any transitional frontend lockfile.
- Select crate features explicitly; keep native and WASM dependency graphs separate.
- Compiler pin, edition, and package `rust-version`/MSRV are different decisions. Determine the actual resolved workspace MSRV; do not assume Tauri's MSRV covers every selected library.
- Use stable APIs. Do not enable nightly-only framework features just to follow an old example.
- Upgrade compiler, framework, native engine, and agent-protocol versions in independently reviewable changes.
- Do not freeze an outdated toolchain indefinitely: Rust does not provide an upstream LTS security branch for old releases.

### Recheck at implementation start

**Not executed by this document.** These commands require an installed Rust toolchain and may download updates:

```sh
rustup update stable
rustc +stable --version --verbose
cargo +stable --version
```

Compare with the [stable distribution manifest][R3] and Rust release announcement. Recheck each Tauri package's registry version, publication date, yank status, and tagged release. Updating `stable` does not require changing the global default; pin the project deliberately after reviewing the result.

## 5. Target architecture and UI choice

### Why Tauri + Leptos is the first choice

The current UI is already based on DOM layout, CSS tokens, rich text, sandboxed documents, and browser-shaped interactions. A Rust/WASM DOM UI lets us preserve that rendering model while moving component/state code out of TypeScript.

Leptos supports client-side rendering on stable Rust [L1]. Use CSR/static assets for the desktop application. Tauri is a static frontend host, not a built-in SSR server [T7]. The official Tauri Leptos example describes an older Leptos 0.6 setup; it is a useful integration concept, **not a copy-paste recipe for 0.8.22** [L2].

Fine-grained reactivity is a reason to evaluate Leptos, not proof that it will outperform the existing UI. Long transcript rendering, text selection, IME, and streaming must be tested with CubiQ-shaped fixtures.

### Alternatives

| Option | What it buys | What it costs or does not solve |
|---|---|---|
| Tauri + React | Fastest route to validating a Rust backend with existing screens | First-party UI remains JS/TS; browser/CDP and Claude gates remain |
| Tauri + Leptos | Rust UI, existing CSS/DOM model, typed shared DTOs | Full component rewrite; host bindings and specialized widgets still need work |
| Tauri + Yew | Rust/WASM virtual-DOM model familiar to React developers | Similar rewrite; choose if team expertise or prototype results favor it [L3] |
| Dioxus desktop | Rust component code and its own desktop/web tooling | Stable desktop rendering is system-webview based; it does not inherently solve CDP [L4] |
| Slint | Native rendering and declarative designer tooling | `.slint` DSL, licensing decision, different rich-content/browser integration [L5] |
| egui/eframe | Rust immediate-mode native UI, useful developer-tool ergonomics | Different product rendering model; text, accessibility, and huge histories need proof [L6] |
| iced | Rust message/update/view architecture and native rendering | Rich UI parity work and framework maturity tradeoffs; not an automatic web-feature substitute [L7] |
| Rust-owned CEF shell | One explicit Chromium-based rendering stack without Electron | More desktop/security/packaging ownership; Tauri plugins are not automatically reusable |

Do not run a months-long framework contest. Prototype one representative Leptos vertical slice, then reconsider only if it fails a requirement or the team already has a compelling alternative.

### Minimal proposed repository layout

**Everything below is new/planned, not an assertion that these files exist today.**

```text
Cargo.toml                       workspace
Cargo.lock
rust-toolchain.toml
crates/
  cubiq-core/                    domain types, contracts, errors, pure rules
  cubiq-runtime/                 application services and native modules
    src/
      store/                     SQLite, blobs, migration, JSONL
      agents/                    Claude, Codex, ACP adapters
      providers/                 HTTP/SSE protocols and native agent loop
      tools/                     permission/effect broker and tool implementations
      mcp/                       server, client, gateway, OAuth, legacy adapter
      browser/                   BrowserHost interface and engine adapter
      design/                    assets, editing, exports, renderer coordination
      processes/                 PTY, shells, process supervision
      skills/ memory/ experts/ learn/ automations/
      bin/                       isolated preview/script/render workers as needed
  cubiq-ui/                      Leptos CSR app, presentation state, IPC bindings
src-tauri/
  src/                           thin desktop composition root and commands
  capabilities/                  explicit command/window permissions
  tauri.conf.json                 host/bundle configuration
tests/fixtures/                  sanitized contracts, protocols, migration data
```

Keep persistence and adapters as modules initially. Split a crate only for a real dependency/isolation boundary. The UI must not pull native process/SQLite dependencies into its WASM build.

An optional Rust CLI or `xtask` can reuse the runtime for replay, checks, and packaging. It is not a new long-running daemon. Axum is a candidate for the existing authenticated loopback MCP service; it is not a requirement to add an HTTP API for the desktop UI.

### Proposed process and trust layout

```text
Trusted Rust/WASM app UI
          | narrow commands; scoped ordered subscriptions
Thin Tauri host
          |
Single Rust runtime authority
          +-- dedicated SQLite writer; bounded filesystem/CPU work
          +-- supervised external agent and shell processes
          +-- authenticated local MCP / remote provider clients
          +-- permission-checked tool broker
          +-- browser engine adapter -> unprivileged browsing renderer
          +-- isolated design renderer -> no browsing credentials or host IPC
          +-- isolated Office / QuickJS workers -> narrow broker protocol
```

CEF's own multiprocess model is not the same as a separately hardened application worker. If its browser process is hosted inside the main process, account for the native code/trust implications. Tauri capabilities do not automatically apply to CEF views or independent HTTP endpoints.

## 6. Feasibility gates: prove these first

Each spike produces a disposable prototype, fixtures, actual platform results, and a short decision record. **Available crates are candidates, not passed gates.** Start browser and Claude spikes in parallel. Plan around three to six weeks for initial evidence with experienced contributors; platform access or deep integration failures can extend this.

### Gate A — Embedded browser and design rendering

**Current behavior:** `src/main/browser/controller.ts`, lines 25–113, attaches Chromium CDP to Electron's browser guest. It uses real input, device emulation, Runtime/Network/Log events, page snapshots/refs, screenshots, picking, and user takeover. `BrowserPanel.tsx` uses the persistent `persist:unskilled-browser` partition.

Tauri normally uses WebView2 on Windows, WKWebView on macOS, and WebKitGTK on Linux [T8]. WebView2 has Chromium APIs; the other engines do not expose an equivalent universal CDP surface. JavaScript `element.click()` is not a silent substitute for real input.

**First prototype:** embedded CEF using a Rust host adapter, coexisting with the Tauri UI. Official CEF supports embedding and DevTools/native-input interfaces [B1], [B2]. `tauri-apps/cef-rs` is a candidate Rust binding, **not evidence that stable Tauri has a drop-in CEF runtime** [B3].

Deliverables and required results:

- [ ] Resize an actual in-app browser pane alongside the UI, including split panes and overlays.
- [ ] Verify focus, keyboard shortcuts, native dialogs, clipboard, drag/drop, IME, scaling, and multiple monitors.
- [ ] Exercise Windows, macOS, Linux X11, and the intended Wayland configuration. Record unsupported combinations.
- [ ] Navigate, click/type with real input, emulate existing device sizes, inspect refs, collect console/network failures, and capture screenshots.
- [ ] Preserve documented existing iframe/shadow-DOM behavior; record current limits rather than inventing broader support.
- [ ] Serialize shared browser mutations. After takeover is acknowledged, no queued agent action may execute.
- [ ] Persist a fresh dedicated browser profile, verify logout/login persistence, crash recovery, and shutdown cleanup.
- [ ] Package a signed/test installer with all engine helpers/resources and a functioning sandbox. Identify who will ship Chromium security fixes.
- [ ] Verify no web page can reach application commands, provider secrets, or arbitrary filesystem reads.

Use app-controlled visible Chromium with a Rust CDP client such as `chromiumoxide` as a cheaper protocol experiment [B4]. Its event handler must be continuously driven. **A separate Chrome window is not embedded-pane parity.** Accept it only if the user explicitly approves that UX change.

Fallback decisions:

1. Embedded CEF + Tauri passes: retain the proposed architecture.
2. Embedded CEF works but coexistence with Tauri is untenable: evaluate a Rust-owned CEF shell with the same runtime/UI boundaries.
3. Only external Chromium works: use detached browsing only after explicit user approval; otherwise halt this migration path.
4. System-webview adapters are chosen: publish the exact per-platform capability gaps and obtain approval; do not call reduced browser behavior unchanged parity.

**Profile rule:** do not attach to the user's everyday browser. Chrome's remote-debugging changes and app-bound encryption make profile/cookie portability an explicit problem [B5]. Start a dedicated profile and expect the user to sign in again. Do not promise automatic Electron cookie migration.

**Design renderer:** separately prove generated HTML, local fonts/assets, canvas edits, PNG capture, and HTML-to-PDF. Use isolated CEF/headless Chromium with no browsing credentials and restricted network/filesystem access [B6]. Chrome for Testing is useful for controlled testing, but does not auto-update and is not automatically the right persistent arbitrary-site browser [B7].

**Stop condition:** if required embedded interaction or safe packaging cannot be demonstrated, do not continue on the assumption that a plugin will appear later.

#### Browser walkthrough — replace the host boundary, not the whole UI

This is a **proposed disposable proof**, not an implemented integration. Replace only Electron-specific browser hosting first; do not rewrite the application UI or browser business contracts to get a demonstration working.
CEF remains a C/C++ Chromium dependency. Neither Rust bindings nor this diagram establish a standard Tauri CEF plugin or vendor-supported coexistence [B1], [B2], [B3].

```text
Proposed Tauri window
  +-- trusted app UI: minimal harness / optional current React -> eventual Leptos WASM
  |      | narrow commands + pane rectangle/visibility
  |      v
  |    Rust runtime: existing browser tool contracts -> permission/effect broker
  |      |
  |    Rust BrowserHost adapter (backend-only engine/session handles)
  |      | release-confirmed CDP / real native CEF input
  +-- embedded CEF browser pane (untrusted page; no application IPC)
```

The first window needs only a panel and **Open, Snapshot, Click, Type, Screenshot, Takeover** buttons; an agent is unnecessary for the first browser proof.
An optional existing React harness is temporary, not a change to the Rust/WASM endpoint. Preserve existing component responsibilities, theme/palette, typography/local fonts, spacing, design tokens, and responsive behavior; this is not permission to redesign `BrowserPanel` or the surrounding shell.

The trusted UI reports the pane rectangle, visibility, and coordinate-space metadata. Rust validates bounds/window ownership and converts CSS pixels, device-independent pixels (DIPs), and device pixels under the current zoom and monitor scale.
Position, hide, resize, and destroy the native view on the required platform thread/event loop, including caption/hit-test regions. A CSS rectangle alone does not position a native CEF child view.
Native-overlay z-order, clipping, focus, IME, Wayland integration, main-loop coexistence, and closing are **core feasibility risks**, not polish deferred until after the rewrite.

**Conceptual BrowserHost contract — operation names, not a compiled Rust trait or promised crate API:**

| Operation | Boundary to preserve |
|---|---|
| `navigate` | App-owned page/session navigation; existing permission and provenance rules |
| `snapshot` | Current snapshot/ref semantics and their documented limits |
| `click` | Validated coordinates/refs and real input, not DOM `element.click()` |
| `type` | Real keyboard/text input with observable focus and input events |
| `screenshot` | Existing image/viewport contract, with bounded backend-owned bytes |
| `setDevice` | Existing device presets, scale and viewport semantics |
| `collectLogs` | Current console/network/log records and ordering |
| `setPaused` | Takeover ownership/generation barrier, not merely a UI toggle |

Keep engine, native-view, profile, and CDP session handles confined to the backend. The trusted UI receives scoped data, not unrestricted DevTools access.
Retain business tool descriptions, the permission broker, and provenance. Audit the current `src/main/browser/controller.ts`, `snapshot.ts`, and `picker.ts` page bridges; do not replace their page/context scripts wholesale or quietly broaden iframe/shadow-DOM support.

#### Browser walkthrough — ordered proof sequence and protocol mapping

The following sequence complements the existing Gate A checklist; it does not replace any acceptance item.

1. **Local fixtures first.** Propose a local fixture page with input/keyboard/focus traces, a click counter, popups, network failures, console output, scrolling, and iframe/shadow cases within existing limits.
   Record expected events and screenshots before adapting the host. Use synthetic login/logout persistence in a fresh dedicated profile, never personal accounts, live browser sessions, or copied browsing credentials.

2. **Native embedding before agent orchestration.** Embed CEF beside the minimal trusted UI and prove pane visibility, resize, caption regions, DPI/monitor changes, zoom, and overlay focus.
   Check keyboard/IME routing and native popup ownership, including hide/show and window closing. A separate headful Chromium window or a screenshot displayed in a panel does not pass this step.

3. **Map the current browser contracts.** Use the CDP/native mapping below, selecting only commands confirmed for the pinned CEF/Chromium release and actual binding coverage.
   Preserve Runtime/Network/Log subscriptions, the current ref/picker helpers through audited page bridges, device sizes **390 × 844** and **768 × 1024**, and screenshot semantics.
   Continuously drive both the native CEF message loop and, when used, the `chromiumoxide` handler; an undriven handler or conflicting main loop is not a working adapter [B1], [B4].

4. **Prove takeover, cancellation, and failure.** Stamp queued actions with ownership/turn generations; pause/revoke the old generation and cancel waits for the shared browser lock.
   Recheck ownership immediately before dispatch, including commands queued for the native loop. Acknowledge takeover only after a barrier has rejected queued old-generation actions and quiesced already in-flight dispatch.
   An already dispatched input cannot be un-executed: wait for its outcome/quiescence before acknowledging, or report failure/uncertainty rather than a successful takeover acknowledgement.
   Record uncertain effects after interruption/crash; never replay them automatically. After acknowledgement, **no queued agent action may execute**. Exercise engine crash, shutdown, helper reaping, and orphan cleanup.

5. **Prove design rendering separately.** Use an isolated renderer/profile with no browsing credentials or application IPC. Deny network access by default and serve locally bundled fonts and scoped fixture assets [B6]. Any remote font/asset access is a separately approved scope change, not current design-preview parity.
   Compare generated HTML/canvas edits and PNG/PDF exports using fixed inputs, fonts, viewport/scale, and engine version. Wait deterministically for fixture readiness, font/image completion, and settled layout with a bounded timeout, not an arbitrary sleep.
   Record PNG tolerances and PDF page/layout expectations; arbitrary-site browsing success does not prove export fidelity or renderer isolation.

6. **Install actual native bundles.** Exercise installed Windows, macOS, and Linux bundles for each intended architecture, including X11/intended Wayland behavior, helpers/resources, shutdown, and sandbox evidence.
   Record signing/test-install status, native dependencies/licenses, and the Chromium security-update owner/policy. A development launch is not packaging evidence [B1].

**Proposed mapping to verify against the selected engine release:** command names describe CDP interfaces, not a promise that every CEF binding exposes them unchanged [B2], [B4].

| Existing need | Proposed engine path | Evidence required |
|---|---|---|
| Navigation | Release-supported `Page.navigate` or native CEF navigation | Correct session/page, navigation outcome, ref invalidation |
| Snapshot and picker refs | `Runtime.evaluate` with audited existing page bridges | Stable ref lifetime, picker results, unchanged iframe/shadow limits |
| Console/network failures | `Runtime`, `Network`, `Log` subscriptions and supported enable commands | Fixture events, ordering, bounded collection and cleanup |
| Click/keyboard/text | Supported `Input` dispatch commands or real native CEF input | Focus/keyboard/pointer traces and counter change; no DOM-click shortcut |
| Device presets | Supported `Emulation` metrics/device commands | 390 × 844 / 768 × 1024 behavior, zoom/scale coordinate checks |
| Screenshot | Supported `Page.captureScreenshot` | Viewport/clip/scale and image output match the current tool contract |
| Pause/takeover | Rust queue/ownership barrier around all dispatch paths | No queued action after acknowledgement; in-flight/uncertain outcomes recorded |

An app-owned external headful Chromium plus `chromiumoxide` can cheaply prove fixture/protocol portions of steps 1 and 3, **not the embedded-pane gate** [B4].
Follow the fallback order above: embedded CEF + Tauri, then a Rust-owned whole CEF host if coexistence fails, then external Chrome only with explicit user approval; otherwise halt.
Any system-webview alternative is a separately approved capability re-scope, not a way to relabel failed embedded Chromium parity. Keep the application/UI boundaries and full-port definition unchanged.

### Gate B — Claude and external agent protocol parity

Anthropic documents TypeScript/Python SDKs and recommends CLI subprocess use for other languages [A1]. CLI JSON/streaming output is a starting point [A2]. Parts of the SDK control protocol are documented, but this research did not establish a complete independently versioned Rust-host wire compatibility guarantee [A3].

Current `src/main/agents/claude.ts` does more than text streaming:

- SDK MCP tools, project/private skill/plugin handling, hooks and Bash guardrails.
- Approval suggestions and remembered permissions; plan decisions and question answers/previews.
- Partial messages, nested subagent attribution, session resume/loss recovery.
- Model catalog, context usage/breakdown, and an explicitly experimental plan-limit probe.
- Background-task and stdin/control-stream lifetime handling.

Build a Rust NDJSON/control adapter against a supported unmodified Claude binary. Keep a public/experimental/internal interface ledger. Pin a tested binary range, parse unknown messages conservatively, and maintain release-matched fixtures.

Required results:

- [ ] New session, resume, model/effort change, lost-session recovery, and handoff behavior.
- [ ] Approve once, deny, remembered approval, plan transitions, and question previews/answers.
- [ ] Mandatory Git guard denial even when a permission mode would normally auto-allow a tool. `canUseTool` alone is not an every-tool guard [A5].
- [ ] Interruption while streaming, awaiting approval, executing tools, and receiving child-agent output.
- [ ] No late approval response executes after a turn is cancelled or replaced.
- [ ] Subagent events, background follow-ups where supported, usage/context information, and process cleanup.
- [ ] Platform-correct signal/control behavior; do not assume POSIX signals work identically on Windows.

The SDK has had concrete stream-lifetime fixes: release `0.3.284` fixed premature stream closure affecting background follow-ups, hooks, approvals, and SDK MCP calls [A6]. Do not equate a result message with guaranteed process/session completion.

**Authentication/product gate:** official SDK documentation restricts third-party offerings of claude.ai login/rate limits without prior approval. Legal documentation separately permits an end user to authenticate through an unmodified Claude Code binary's own flow under applicable terms, while prohibiting collection/intermediation of subscription credentials/tokens [A4]. Obtain clarification for CubiQ's actual experience. Default product design should use supported API-key/provider authentication, not a custom subscription-token client.

Codex and ACP also need versioned protocol proofs:

- Codex app-server: preserve initialization/`initialized`, shared-process thread state, approvals, steering/interruption, and release-specific schemas. Its JSON-RPC wire omits the `jsonrpc` member; client version is not a negotiated protocol version. Distinguish stable versus experimental methods [A7].
- ACP: use the official Rust SDK candidate `agent-client-protocol 3.4.0`; negotiate the actual agent's capabilities. Stable ACP v1 and draft v2 features are not Codex's v2 API [A8].

**Stop condition:** missing required Claude controls or unresolved product authorization is not solved by hiding the existing SDK behind a permanent Node sidecar. A temporary sidecar can unblock experiments, but changes the final claim if it cannot be removed.

#### Claude walkthrough — proposed host boundary

Prove replacement of the current TypeScript driver/SDK host while retaining the **unmodified Claude Code CLI**. This is not a new native Rust Claude SDK or a replacement agent loop [A1], [A2], [A3].

```text
Current:  TS Claude driver -> Agent SDK -> unmodified Claude Code CLI
Proposed: Rust Claude driver <-> CLI stdio (NDJSON + control messages)
              +-- minimal trusted approval/question UI <-> permission broker
          CLI tools <-> external Rust MCP server <-> same permission/effect broker
```

These are proposed boundaries, not implemented processes. Keep the existing approval/question semantics and design; the minimal trusted UI presents requests and sends scoped decisions, not arbitrary CLI commands.
The MCP server supplies tools. It does **not** automatically supply SDK hooks, questions, skills/plugin delivery, plan controls, or full control-protocol parity. CLI-owned Bash/Git guards need separately proven hook/control coverage, not merely an MCP tool server [A3], [A5].

#### Claude walkthrough — Stage A: fake executable and host fixtures

Start with a proposed fake executable, not a live model call. These offline fixtures test Rust host behavior; passing them cannot establish compatibility with an actual Claude release.

1. **Safe spawn.** Use an explicit executable/argument vector, disposable project/home directories, and a clean allowlisted environment. Do not read/inherit ambient secrets, inspect token/vault/profile files, or interpolate a prompt into a shell command.
   Specify child/process-tree ownership and platform cleanup before exercising failures. Fixture inputs contain synthetic identifiers and no real authentication material.
2. **Bounded framing.** Parse stdout as NDJSON across fragmented UTF-8/JSON reads and multiple records per read, with line/buffer limits, backpressure, malformed-record handling, and bounded deadlines.
   Keep stderr separate, bounded, and redacted; never treat diagnostic text as protocol JSON. Test overlong records, early EOF, nonzero exit, and malformed control payloads.
3. **Session identity and lifetime.** Capture synthetic CLI session IDs and distinguish new-session, resume, request IDs, parent IDs, and turn generations from host thread IDs.
   Exercise a second turn and background/control messages after the first result. Do **not** close stdin at the first result; close it only according to the explicitly tested session/control lifetime.
4. **Interrupt/control/cleanup.** Script initialization, pending permission/question requests, interrupt responses, delayed replies, child crashes, and inherited-pipe failures.
   Reject a late approval for a cancelled/replaced generation; drain bounded output, escalate stuck children, and reap descendants with platform-correct behavior. Record interrupted/uncertain outcomes rather than duplicate completion.

Store proposed fixture expectations for stdout events, control request/response correlation, stderr handling, exit state, and surviving-process checks. Fake streams may reproduce lifetime hazards without proving that the real binary accepts those requests.

#### Claude walkthrough — Stage B: release-pinned real control parity

Only proceed to a real unmodified CLI after **separate authorization**, using supported authentication and an isolated project/profile. No paid-model test is implicit in approving this plan.
Do not inspect existing subscription tokens, vaults, credential files, browser sessions, or live profiles. Authentication stays with the supported user/CLI flow; the existing product/legal clarification conditions remain an unresolved gate [A4].

Maintain a per-feature interface ledger before asserting support:

| Interface class | What may be relied on | What still needs proof |
|---|---|---|
| Public CLI | Documented input/output, session/resume and CLI controls [A2] | Exact flags/behavior for the pinned binary; text output is not SDK parity |
| Documented SDK controls | Documented initialization, permissions, hooks and SDK features [A3], [A5] | Rust-host request/response wiring and lifecycle; SDK API docs are not a raw-wire compatibility guarantee |
| Implementation-dependent / experimental | Release-observed messages or non-public controls | Explicit feature gate, release-matched fixture, owner, and unsupported/re-scope decision |

Cover initialization, permission/hook requests, questions, plans, resume, child attribution/background lifetime, model/context information, and usage in the ledger.
Do not claim public `-p`/streaming flags alone enable SDK hooks or approvals. Classify unknown messages conservatively, fail closed for unrecognized permission/control requests, and block the affected feature until its release-matched fixture is understood.
Pin actual CLI/SDK reference versions and maintain fixtures on upgrades; do not copy internal SDK behavior indefinitely and call it a stable public protocol.

**Scenario table — concrete evidence for the existing Gate B checklist, not replacement acceptance criteria:**

| Scenario | Required observable result |
|---|---|
| Approve once / deny | Allowed action executes once; denied action performs no effect; request/decision/result correlate |
| “Always allow” | Remembered permission is project-scoped; a different project does not inherit the grant |
| Mandatory Git guard under permissive mode | Guard hook still rejects the prohibited Git action before execution, even when ordinary permission evaluation auto-allows |
| Plan decisions and questions | Preview/answer/plan response reaches the correct request and active generation; stale answers are rejected |
| Second turn, resume, lost-session recovery | Session binding and resumed context remain correct; recovery does not silently replay real actions |
| Subagents and background work | Tool/event parent IDs preserve attribution; background lifetime survives the first result where supported |
| Interrupt with pending approval | Pending request is cancelled; late approval cannot execute; exactly one terminal interrupted outcome |
| Model/context/usage | Correct model and usage/context semantics, or an explicitly unsupported **incomplete gate**, not fabricated zero values |
| Child/process crash | Failure is surfaced, pending requests close, inherited streams terminate, and children/descendants are reaped |

Use isolated temporary repositories and synthetic effect markers. Prove hooks guarding CLI-owned tools as well as broker checks on MCP tools; approval UI alone is insufficient.
If required controls or product authorization remain unavailable, stop/re-scope explicitly. Trading Claude Code for an API agent loop and calling it parity is not an acceptable shortcut.

#### Claude walkthrough — differential event evidence

Run equivalent scenarios through the current TS driver and proposed Rust driver with separate profiles and temporary repositories, never two hosts acting on the same real project/session.
Use fixtures first; any authorized real comparison uses independent synthetic actions, not duplicate execution of a user's Git/filesystem/browser operation.

- Normalize timestamps and random run IDs through an explicit mapping, while preserving sequence ordering, tool/parent links, request generations, and session bindings.
- Permit documented semantic mappings for different transport envelopes or partial-message chunking; do not normalize away errors, missing events, permission denials, or changed effects.
- Count tool starts/results, permission requests/decisions, assistant events, session bindings, usage, completion, and interruption. Reconcile every started tool and pending decision with its terminal outcome.
- Require zero unexplained duplicates and zero unclassified/unknown protocol events in the pinned scenario suite. Preserve unknown usage as unknown, not zero; do not double-count subagent/background usage.
- Record expected versus actual counts/order, mapping rules, failures, and CLI exit/process state. A text-only demonstration cannot pass controls, recovery, attribution, or cleanup.

### Gate C — Data, secrets, preview/script workers, and UI

Run these smaller proofs alongside the two main gates:

| Proof | Required result | Failure response |
|---|---|---|
| SQLite compatibility | Synthetic legacy profiles migrate idempotently; FTS5, IDs, cursors, events, blobs and totals match | Keep schema unchanged; fix compatibility before importing real data |
| Secret-store behavior | Disposable credentials work on each OS; unavailable/locked storage fails closed | User re-entry/reauthorization, not plaintext fallback |
| Office previews | Representative DOCX, spreadsheet, and PPTX fixtures meet current semantic preview behavior | Implement missing conversion or explicitly renegotiate fidelity |
| QuickJS worker | CPU/memory/promise limits and broker revocation work; worker crash is contained | Do not load untrusted native engine code into the trusted service |
| PTY and terminal UI | Full-screen apps, resize, Unicode/IME, selection, paste, cleanup work | Budget a real renderer or explicitly approve xterm exception |
| Leptos UI slice | Long streamed history, tool cards, composer, focus/selection, narrow layout match | Reconsider UI choice before porting every component |
| Native packaging | Representative Windows/macOS/Linux bundles launch with engine/worker resources | Establish platform floor and dependencies before promising coverage |

These prototypes use generated/sanitized fixtures and disposable accounts only. They do not require opening any existing credential file or live user profile.

### Shared gate evidence and decision record — proposed, not executed

Browser and Claude evidence must stay separate from implementation claims. The initial matrix below records **no executed tests**; fill it only with actual fixture and installed-bundle evidence from a separately authorized feasibility stage.

| Capability | Windows | macOS | Linux | Gap | Decision / Evidence |
|---|---|---|---|---|---|
| Embedded pane layout, visibility, resize, overlays | Not tested | Not tested | Not tested | Not established | Pending |
| Real input, focus, keyboard/IME, DPI/zoom | Not tested | Not tested | Not tested | Not established | Pending |
| CDP refs/picker, device emulation, screenshots/logs | Not tested | Not tested | Not tested | Not established | Pending |
| Takeover barrier, cancellation, crash/shutdown | Not tested | Not tested | Not tested | Not established | Pending |
| Dedicated browser profile and renderer isolation | Not tested | Not tested | Not tested | Not established | Pending |
| Deterministic design PNG/PDF export | Not tested | Not tested | Not tested | Not established | Pending |
| Claude permissions, questions/plans, mandatory Git guard | Not tested | Not tested | Not tested | Not established | Pending |
| Claude second turn/resume/recovery and interrupt | Not tested | Not tested | Not tested | Not established | Pending |
| Claude subagents/background lifetime, model/context/usage | Not tested | Not tested | Not tested | Not established | Pending |

Status definitions:

- **PASS:** the stated capability met its fixture/acceptance contract on the named platform/bundle; attach evidence and limits, not a general claim that the entire gate passed.
- **FAIL:** execution demonstrated a contract mismatch, unsafe behavior, or missing required capability; retain the actual result and blocker.
- **BLOCKED:** testing cannot proceed because authorization, platform access, packaging, or a required supported interface is unavailable; name the dependency/owner.
- **NOT TESTED** (shown initially as “Not tested”): planned but not run. Source research, fake-host tests, and external-browser protocol tests cannot substitute for real CLI/embedded-pane evidence.

Each future evidence record must include:

- Exact source revision; binary/engine/framework/binding/CLI/SDK versions and relevant build options, rather than only “latest” or a crate version.
- Exact commands/arguments and bounded redacted logs; do not collect ambient secret values or personal-session data to make a report reproducible.
- Fixture inputs, expected versus actual events/effects/counts, screenshots/exports, timing/readiness rules, and any approved semantic mapping/tolerance.
- OS release, native installed bundle, CPU architecture, display backend/scale, helper/process cleanup, and sandbox/signing evidence; Linux X11 and intended Wayland results remain distinguishable.
- Remaining non-Rust code, generated/handwritten page bridges, native dependencies/licenses, supported-interface limitations, and security-update/authentication policy.
- Chosen fallback or stop/re-scope decision, explicit user approval where required, remaining gaps, and an owner/due date for each unresolved item.

**Proposed future artifact paths only:** `tests/fixtures/browser-host/`, `tests/fixtures/claude-host/`, and `docs/migration-evidence/gates/<platform>/<run-id>/` for manifests, event comparisons, redacted logs, and decision records.
This update creates none of those artifacts and executes no prototypes, authentication flows, model calls, or platform tests.

Run browser and Claude proofs in parallel rather than prioritizing a huge UI/runtime rewrite. Simple text/protocol demonstrations may take days; real control parity, native embedding, security, and packaging need a weeks-scale evidence budget.
Keep the existing **three-to-six-week initial evidence budget** as a planning assumption, not an exact delivery guarantee; blockers may extend it, and a failed gate must trigger a decision rather than an implicit full rewrite.

## 7. Module-by-module replacement map

Candidate versions below were publicly checked during research. They are **not a tested combined dependency graph**, nor a promise that every candidate is the absolute latest on implementation day.

| Current subsystem | Proposed Rust implementation | Risk / acceptance check |
|---|---|---|
| Shared TS types/rules | `cubiq-core`, Serde DTOs, pure permission/model/binding rules | Golden JSON: tags, casing, null/absent, units, numbers, binary paths |
| Electron-free Service | `cubiq-runtime` service facade and supervised per-thread tasks | One authoritative executor; pending state, queueing, cancellation parity |
| `node:sqlite` store | `rusqlite 0.40.2` and a dedicated database worker [D1] | Preserve SQL/schema/migrations; FTS5, WAL, foreign keys, blob consistency |
| Provider HTTP/SSE | Tokio + `reqwest 0.13.5`, explicit protocol decoders | Fragmented UTF-8/JSON, retry boundary, usage and cancellation |
| Claude SDK host | Rust CLI/control-protocol adapter + external Rust MCP server | Gate B; public versus experimental interfaces recorded |
| Codex/ACP drivers | JSONL adapter; official ACP Rust SDK | Release-matched schema fixtures, capability gaps, restart/resume |
| MCP SDK/Zod | `rmcp 3.6.0`, schema generation plus explicit validation | Transport/OAuth compatibility; schema validation is not authorization |
| Interactive/background processes | Tokio `1.54.1`, `portable-pty 0.9.0`, platform supervision | PTY and full descendant cleanup, not child-only kill |
| Browser/CDP | BrowserHost abstraction; CEF or approved Chromium adapter | Gate A, in-app UX, ownership, engine security/update policy |
| Design capture/export | Isolated browser renderer and scoped asset serving | Fonts, timing, PNG/PDF fidelity; no privileged content access |
| Spreadsheet previews | `calamine 0.37.0` + `csv 1.4.0` [O1], [O2] | Retained formats and formatted dates/numbers; values are not a renderer |
| DOCX/PPTX/archive handling | `zip 9.0.5`, `quick-xml 0.42.0`, dedicated conversion code [O3], [O4] | Semantic HTML/images/relationships and malicious archives |
| Existing PDF preview | Browser viewer or optional `pdfium-render 0.9.4` [O5] | Native PDFium is separate; existing-PDF rasterization is not HTML-to-PDF |
| QuickJS-Emscripten | `rquickjs 0.14.0` in an isolated worker [Q1] | Native safety boundary, limits, staged state, late tool-call revocation |
| SecretBox/safeStorage | Explicit native keyring stores; optional separate vault model | Re-entry default; Electron ciphertext compatibility not assumed |
| Git/worktrees | Retain Git CLI behind typed Rust operations | Quoting, hooks/LFS/worktrees/dirty paths; no premature libgit2 substitution |
| Skills/memory/experts | Rust parsers, contained file storage, catalog and prompt composition | Precedence, IDs, frozen prompts, private skills, import limits |
| Learning/evals/automation | Rust modules and replay tooling using same runtime | Budget/accounting, DST, leases, deliveries, no duplicate schedules |
| Markdown/syntax/rich UI | Rust rendering, e.g. pulldown-cmark/syntect; validated UI blocks | Extensions/diagrams/security/interaction parity, not just plain Markdown |
| Electron IPC/desktop | Tauri scoped commands/channels and thin native adapters | Native behavior, custom schemes, command authorization, ordered streams |

### Persistence choice

Prefer `rusqlite` initially because the current store already uses synchronous SQLite and explicit SQL. A dedicated worker can preserve that model without blocking the UI or async executor. A connection is not a shared async service just because it can be moved between threads.

SQLx is a viable alternative, but SQLite still has one writer and SQLx's SQLite async interface uses worker threads. A large pool does not create parallel write capacity. Do not combine a language migration with an unnecessary ORM rewrite.

Verify the actual bundled engine version and FTS5 build options on every target [D2], [D4]. SQLite's documented WAL-reset corruption fix is in 3.51.3 and verified backports; selecting a Rust crate version alone does not establish a secure native SQLite engine.

### MCP: the important gap

`rmcp 3.6.0` is an official Rust SDK with stdio, Streamable HTTP, client/server, and OAuth facilities [M1]. However, it **explicitly does not provide the old 2024-11-05 two-endpoint HTTP+SSE transport**. Its SSE parsing inside Streamable HTTP is not legacy `SSEClientTransport`.

The application currently supports legacy SSE in `src/main/mcp/transport.ts`, lines 4–23. Budget a Rust compatibility adapter/proxy and regression tests. Dropping it requires an explicit compatibility decision.

Retain the local loopback token-auth server and scoped `/mcp`, `/mcp-skills`, `/mcp-routed` behavior, remote gateway credential isolation, BM25 routing/schema caches, per-project server precedence, question progress, OAuth callback/discovery/refresh, and cancellation.

Serde validates the chosen Rust data shape. It does not enforce arbitrary external JSON Schema constraints. `schemars` generates schemas; use an actual validator such as `jsonschema 0.59.0` when validating discovered tool schemas, with uncontrolled network/file `$ref` retrieval disabled [M2].

### Terminal and process supervision

`portable-pty` supplies PTYs, not the entire terminal product [P1]. A VT parser is not a terminal renderer. `alacritty_terminal 0.26.0` supplies terminal state/grid machinery; it still needs UI rendering, input, selection, clipboard, IME, scrollback, links, and accessibility [P2].

For a strict Rust UI endpoint, prototype a Rust terminal model with a WASM/native rendering adapter. If this is not viable, explicitly decide whether third-party xterm.js is an allowed exception. Keep that decision visible in the final dependency register.

Use explicit process lifetime ownership:

- POSIX: process groups/sessions, staged interruption/termination, output draining, and reaping. Test descendants that change session/group.
- Windows: Job Objects, assignment before uncontrolled execution, kill-on-close, and correct shell launching [P3].
- Dropping a handle or killing one child is not proof that all grandchildren and inherited pipes are gone.
- Preserve Windows `.cmd`/`.bat`, PowerShell/Git Bash behavior and paths with spaces/Unicode. Keep agent command-shell selection separate from interactive terminal selection.

### Office and script workers

Current Office behavior is defined by `src/main/preview/office.ts`: DOCX semantic HTML, formatted spreadsheet strings, and PPTX titles/text/images. It is not a complete Office layout engine.

- Preserve the 25 MB input/10-second worker contract, 5,000-row truncation, warnings, and PPTX image budget.
- Add explicit decompressed-byte, entry-count, XML-depth/text, image-dimension, and relationship/path limits.
- Calamine reads workbook data; date/number formatting needs parity work. Never execute macros.
- ZIP/XML libraries do not replace Mammoth automatically. Implement headings, lists, tables, links, images, notes, and supported inline formatting against fixtures.
- Existing PPTX code sorts `slideN.xml` numerically. OOXML presentation order can differ; treat fixing that as an explicit, tested behavior change.
- Keep native parser crashes/timeouts away from the trusted runtime and renderer.

`run_code` must continue accepting JavaScript with the existing tool API. Preserve 30-second/64 MiB limits, excluded recursive tools, bounded JSON state, successful-only state commits, and the warning that prior external tool effects are not undone.

Native QuickJS is not equivalent to a WASM or OS sandbox. `rquickjs` exposes interrupt/memory controls, but its memory limit is documented as ineffective with custom allocators including `rust-alloc` [Q2]. Select features deliberately and test actual enforcement. Add a host deadline for unresolved promises, OS worker limits where available, and revocation of further broker calls after timeout/cancellation [Q3].

## 8. Runtime, contracts, and concurrency rules

### Preserve the contract before improving it

Start from `UnskilledApi`, `AgentDriver`, `TurnInput`, stored events, and live updates. Do not recreate them from screenshots.

- Preserve event `kind` tags, camelCase fields, optional-versus-null behavior, IDs/cursors, time/byte units, and numeric precision.
- Keep canonical event sequence IDs stable. Preserve provenance, message/turn/item/parent identifiers and offloaded blob references.
- Preserve unknown usage versus zero usage. Do not double-count child usage or omit compaction/background calls.
- Define structured errors at the new host boundary without silently changing old event/error payloads.
- Keep large binary data on bounded raw-buffer/asset paths rather than enormous JSON arrays.
- Store unknown-but-compatible fields where necessary for import/export and future adapter messages.
- New subscription envelopes can be versioned separately; do not unnecessarily retag historical JSON.

The existing event table is durable conversation history. This plan does **not** redesign the whole product into an event-sourced system.

### One runtime authority

- One execution owner and one serialized database writer per profile.
- One scheduler; no Electron scheduler plus Rust scheduler running imported jobs twice.
- Independent conversations can progress concurrently, but a thread's own turn lifecycle remains ordered.
- Shared browser/tool mutations require explicit ownership. Automatically permitted does not mean parallel-safe.
- Never hold a database/resource mutex across a provider request, pending approval, or other unbounded `await`.
- Use bounded mailboxes/queues and explicit shutdown ownership, not detached tasks everywhere.

### Durable events versus live output

Commit a canonical event before publishing its durable notification. Live text/tool-argument deltas are a separate ephemeral stream; there is no need to transact every character into SQLite.

Tauri channels are the recommended ordered streaming primitive [T9]. Generic events are not a durability, replay, or backpressure mechanism.

Proposed delivery rules:

1. Scope subscriptions to a trusted view/thread and identify runtime epoch/turn generation.
2. Register/buffer a subscriber before capturing its history/state watermark, then reconcile snapshot and buffered events with deduplication. Avoid the history-fetch/subscribe race.
3. Use canonical `seq` for durable replay; use separate live offsets/generations for deltas. Do not pretend a live offset is a database cursor.
4. Bound queues. Coalesce display-only deltas where safe; never silently discard approvals, tool results, errors, or terminal completion.
5. A slow/reloaded UI must resynchronize from a durable cursor and active-turn snapshot, not rerun the agent.
6. Document crash semantics for partial live content not yet canonicalized. Do not promise byte-perfect recovery of every delta unless implemented.
7. Apply consumer acknowledgements/batching when needed. A Tauri channel alone does not implement application backpressure.

### Cancellation is a product behavior

- A turn carries a cancellation token and generation identity through adapters, tools, approvals, workers, and streams.
- Approval/question responses are valid only for the pending request in that active generation.
- Cancellation closes or rejects pending decisions and revokes new privileged worker calls.
- Late provider/worker results cannot revive a replaced turn or append duplicate completion.
- Every started tool call receives a terminal result or explicit interrupted/refused outcome.
- Escalate stuck children with platform-correct cleanup and reap them.
- Already completed filesystem/Git/browser/remote actions cannot generally be rolled back by cancelling a turn.

### Provider-loop behavior to preserve

The current native loop has a 100-step limit and groups up to eight consecutive parallel-safe tools. Its HTTP retry policy retries only before output has been emitted; the default is two retries and a five-minute stream idle timeout.

Port these behaviors before tuning them. Test chunk boundaries, tool-argument accumulation, partial usage/error events, cancellation, tool ordering, and context compaction. Preserve stable prompt/tool serialization and frozen memory blocks: changing them can change model behavior and cache hits even when the UI looks the same.

Retries after a request may have produced external effects require explicit idempotency support or an uncertain-result state. **Do not promise exactly-once network effects.**

## 9. Implementation phases

Phases describe deliverables and gates, not permission to start changing code. Keep ordinary product work separate from migration work. Each phase needs an actual review, tests, and a rollback decision before wider cutover.

### Phase 0 — Freeze a reproducible baseline

**Source:** manifests, shared contracts, `test/fixtures`, current CI, `DESIGN.md`, and implemented feature modules.

Deliverables:

- [ ] Record the chosen source revision and all unrelated working-tree changes before implementation.
- [ ] Establish supported OS/CPU targets from actual shipped artifacts and product decisions.
- [ ] Inventory all `UnskilledApi` methods and agent capability differences; mark public/experimental external calls.
- [ ] Capture sanitized canonical JSON, fake protocol streams, legacy schemas, blob/JSONL examples, and Office fixtures.
- [ ] Record representative screens and behaviors using disposable data and current design tokens.
- [ ] Measure startup, idle/busy RAM, installer size, history load/search, browser/design capture, and shutdown.
- [ ] Separate offline checks from live/paid/account-enabled checks; document explicit consent requirements.

**Exit:** a parity matrix where every existing feature has a source anchor, owner, fixture/check, and unresolved caveat. No invented test totals or performance baseline.

**Rollback/non-Rust status:** production remains Electron; no user profile is migrated.

### Phase 1 — Run the feasibility gates

**Dependencies:** Phase 0 fixture/requirements baseline. Browser and Claude can proceed independently.

Complete Gates A–C, including actual Windows/macOS/Linux packaging evidence. Write the browser/UI/authentication/secret-store decisions before large implementation begins.

Use Section 6's ordered browser/Claude walkthroughs and shared capability/evidence matrix to distinguish offline host fixtures, separately authorized real protocol proofs, and installed-bundle parity.

**Exit:** either an approved architecture with enumerated gaps, or a stop/re-scope decision. A “Rust window launches” result is insufficient.

**Rollback/non-Rust status:** disposable prototypes only; temporary React/Node experiments clearly labeled and not released as the finished port.

### Phase 2 — Establish workspace, contracts, and compatible storage

**Source:** `src/shared`, `db.ts`, `harness/session.ts`, artifacts/blob handling, settings interfaces.

Deliverables:

- [ ] Minimal workspace with native/WASM feature separation and reproducible toolchain/lockfiles.
- [ ] Rust DTOs and golden compatibility tests for contracts and event payloads.
- [ ] Dedicated database worker; existing 31 migrations translated without unnecessary schema changes.
- [ ] Functional WAL/FTS5/foreign-key/busy-timeout tests and backup/restore support.
- [ ] Atomic content-addressed blob writes, hash validation, references, and safe orphan cleanup.
- [ ] JSONL torn-tail recovery, atomic replacement, stable session metadata and bindings.
- [ ] Profile lock, lifecycle/shutdown, bounded internal queues, structured nonsecret logging.
- [ ] Secret-store abstraction with disposable test stores; no real credential import.

**Exit:** differential synthetic-profile tests agree on history, search, totals, versions, bindings, and migration idempotence; interrupted operations do not corrupt the original fixture.

**Rollback/non-Rust status:** Rust owns its isolated test profile only. Electron stays the production baseline. Never run both writers on the same profile.

### Phase 3 — Port agent execution and providers

**Source:** `service.ts`, `agents/`, `harness/`, provider/model catalog, handoff, permission and context rules.

Deliverables:

- [ ] Thread lifecycle, queueing, generation/cancellation, pending approvals/plans/questions, and project-scoped trust.
- [ ] OpenAI Chat, OpenAI Responses, Anthropic Messages decoders and current native tool loop.
- [ ] Context/prompt composition, compaction, memory snapshot inputs, usage/cache/cost semantics.
- [ ] Codex and ACP adapters with fake-process fixtures and capability gates.
- [ ] Claude Rust adapter from the approved Gate B design, including experimental-feature fallbacks.
- [ ] Agent switching/handoff/back, lost-session recovery, and post-turn checks/fix rounds.
- [ ] Runtime-state snapshot/subscription API suitable for both transitional and Rust UI clients.

**Exit:** offline fake-agent/fake-provider workflows match canonical behavior, with successful interruption/restart tests. Live CLI/model checks are separately authorized and isolated.

**Rollback/non-Rust status:** old production app unchanged. Any Node Claude bridge is an explicitly temporary blocker with a removal issue and no full-port claim.

### Phase 4 — Port tools and desktop-dependent integrations

**Source:** MCP/gateway/OAuth, filesystem/artifacts, Git/worktrees, terminals/shells, browser, design, preview, `run_code`, editor/Doctor integration.

Deliverables:

- [ ] A common permission/effect broker used by native providers, MCP, script workers, and browser tools.
- [ ] Rust MCP client/server/gateway, including legacy SSE compatibility, OAuth refresh and scoped local tools.
- [ ] Contained file access, watchers with debounce/rescan recovery, artifacts and content-addressed versions.
- [ ] Git CLI parity, worktree review/merge/push/removal safety, Windows quoting.
- [ ] PTYs/background shell supervision, output cursors and bounded buffers, process-tree cleanup.
- [ ] Embedded browser adapter and takeover/ownership behavior from Gate A.
- [ ] Design serving/editing/comments/versions and isolated export renderer.
- [ ] Office and QuickJS workers with resource limits, safe protocols, cancellation and crash recovery.
- [ ] Desktop dialogs, reveal/open-editor actions, diagnostics, lifecycle and custom asset schemes.

**Exit:** representative workflows run in real native bundles on all supported platforms, including worker/process crashes and malicious-input tests. No new blanket frontend filesystem/shell capability bypasses the broker.

**Rollback/non-Rust status:** preserve the original app/profile and disposable project copies. Browser engines, agent CLIs and native libraries remain declared dependencies, not unfinished TypeScript logic.

### Phase 5 — Port the less-visible product behavior

**Source:** `skills/`, `memory/`, `experts/`, `learn/`, `automations/`, runtime-used `evals/` functionality.

Deliverables:

- [ ] Skill discovery precedence, delivery modes, disable/shadow behavior, bundled resources and prompt stability.
- [ ] Memory project/global scopes, native imports through approved app flows, frozen session blocks and later updates.
- [ ] Expert catalog/imports/private skills, team message/result files, member model selection and cursors.
- [ ] Learning scorecards, cases/lessons, budgets, replay/holdout checks, promotion/retirement and accounting.
- [ ] Scheduling/timezone/DST/missed-run policy, leases/cursors, delivery reconciliation, Message Center results.
- [ ] Explicit desktop wake/exit behavior; do not introduce daemon/tray promises as part of parity.

**Exit:** deterministic replay and clock-driven tests prove behavior; no duplicate job or lesson promotion. Imported real automations stay disabled until user confirmation.

**Rollback/non-Rust status:** no runtime dependency on TypeScript evaluation code remains. External skill scripts/runtimes are inventoried rather than silently dropped.

### Phase 6 — Replace the first-party UI in vertical slices

**Source:** `src/renderer/src`, shared UI rules, `DESIGN.md`, CSS, fonts/assets, rich-message renderers.

This can overlap runtime work after contracts and feasibility stabilize. It is not necessary to port all of React into Tauri first. A temporary existing UI client is optional, and should call the Rust authority rather than leave Electron services secretly running.

Suggested slice order:

1. App shell, sidebar, theme/zoom/native caption geometry, project/thread navigation, settings.
2. Thread history/paging/live updates, composer, model/effort/context, skill/file chips, send/stop.
3. Nested tools/subagents/reasoning, approvals/plans/questions, changes/checks, search/palette/switch.
4. Artifact/source/diff/version panel, files/editor actions, terminal/background shells/browser.
5. Design workspace: pages/variants, board/flow/presentation, references/drawing/comments/edits/exports.
6. Library/MCP/memory/experts, learning, Message Center/automations, diagnostics/About/splash/update states.
7. Rich reply blocks, Markdown extensions/diagrams, previews and their remaining dependency decisions.

Per-slice requirements:

- [ ] Preserve current component responsibilities and existing CSS tokens; do not mix migration with redesign.
- [ ] Reuse local Geist/Geist Mono assets and respect light/dark/system, motion, focus and keyboard behavior.
- [ ] Keep responsive sidebars/panels, 900 px narrow-window checks, and very narrow chat widths working.
- [ ] Maintain text selection, scroll anchoring, virtualization/history windows, drafts, pending state and reconnect.
- [ ] Replace React-dependent icons/avatar/activity effects without quietly changing visible behavior; approve any replacement.
- [ ] Avoid native dependencies in the UI WASM build and avoid shared DOM ownership conflicts with specialized widgets.

**Exit:** real-host screenshots and functional checks agree with the baseline; mock browser preview alone does not count. Resolve terminal/diagram/host-JS exceptions explicitly.

**Rollback/non-Rust status:** switch frontend builds against isolated profiles without introducing a second runtime. Remaining React is removed only after equivalent Rust slices are accepted.

### Phase 7 — Migration, signed beta, hardening, and retirement

**Dependencies:** complete feature matrix, real platform results, migration/rollback rehearsal, approved engine/authentication policies.

- [ ] Implement the user-driven migration wizard/runbook in Section 10.
- [ ] Publish isolated preview builds before a normal update-channel cutover.
- [ ] Test installers, native signing/notarization, signed updater artifacts, offline/update-failure paths.
- [ ] Run the full security/performance/platform matrix and authorized live adapter checks.
- [ ] Remove Electron, production React/TypeScript, Node application sidecars and TS runtime-used replay code.
- [ ] Replace transitional build scripts where necessary; retain explicit development-only tooling if useful.
- [ ] Publish residual engines/bridges/scripts, licenses, supported versions, update ownership and known limits.

**Exit:** Section 16 passes. If a critical gate remains blocked, ship only under an accurately described hybrid/reduced-scope label.

**Rollback:** preserve the old application and baseline profile. New Rust turns require a tested backward export if they must be visible in the old app; a profile restore alone cannot supply that.

## 10. Data migration and rollback runbook

### Data inventory

The following runtime destinations are inferred from source. **No live database, credential vault, session history, or browser profile was opened for this plan.** Actual locations are computed from the application's user-data root, not assumed from the repository path.

| Data | Treatment |
|---|---|
| `unskilled.db` | Preserve schema/version, IDs, events, search, bindings, worktree metadata, learning and automation rows |
| `blobs/` | Preserve SHA-256 payload/artifact contents and references; coordinate with the database snapshot |
| Native provider JSONL sessions | Preserve format/metadata/torn-tail behavior; do not confuse them with external CLI caches |
| Settings and MCP configuration | Import nonsecret preferences/server definitions through an authorized app workflow; handle encrypted fields separately |
| Encrypted provider/MCP/OAuth material | Default re-entry/reauthorization; no unattended research/worker access |
| Memory and team-run files | Preserve notes/indexes, frozen snapshots, result files, author/read cursors |
| Skills, experts, design content, screenshots | Classify durable user content separately from regenerable caches |
| Worktrees and project files outside the profile | Preserve path/branch references and protect actual user work; profile backup is insufficient |
| Renderer localStorage | Deliberately migrate useful nonsecret UI state; new webview origins do not inherit it automatically |
| Persistent browser profile | New dedicated profile/relogin by default; never promise cross-engine cookie portability |
| External agent sessions/authentication | Remain owned by the agent; do not inspect/copy private caches or run two hosts on one live session |

### Secret-store decision

Electron `safeStorage` encrypts values through OS/app-specific mechanisms [S1]. A Tauri bundle ID or a new keyring record does not automatically decode those ciphertexts.

Use native keyring stores with stable service/account identifiers and explicit locked/unavailable behavior. Research candidates include keyring/keyring-core and platform stores [S2]. Stronghold is a password/key-derived vault model, not a drop-in safeStorage/keyring conversion [S3].

Default wizard:

- Import authorized nonsecret configuration/history.
- Ask the user to re-enter provider secrets and reauthorize OAuth through normal app UI.
- Leave the original encrypted data untouched for rollback.
- Show precisely which integrations require reconnection.
- Never fall back to plaintext because a Linux secret service is unavailable.

A future old-app decryption/export helper is a **separate, explicitly authorized project**. It needs per-OS identity tests, in-memory transfer, no plaintext temporary files/logs, and a clear deletion policy. This plan does not authorize an agent to open a vault or credential file.

### Cutover steps

1. **Choose a source revision and installer pair.** Record Rust build/version and old app version, platform, and migration version.
2. **Pause activity.** User stops active turns/background shells and scheduled runs. Close the old app cleanly; confirm no old writer/scheduler/agent session remains active.
3. **Create a consistent, authorized backup.** SQLite's online backup API or clean checkpoint/close can handle the database [D3]. A live `.db` copy can miss committed WAL contents [D2]. Coordinate blobs/session files and other durable content at the same quiescent boundary.
4. **Protect original data.** Import into a separate Rust profile; never test writes in the only copy of the old profile. Conversation backups are sensitive even without API keys.
5. **Copy/import by category.** Preserve IDs and canonical JSON. Classify caches; disable destructive cleanup until validation finishes. Do not transplant browser/auth caches automatically.
6. **Validate.** Compare table/history counts and hashes on authorized migration data, SQLite integrity/foreign keys, FTS queries, blob hashes/references, versions, session bindings and sidecar files.
7. **Mark interrupted work explicitly.** Do not revive a pending tool/approval as if it were still executing. Revalidate trust and session availability before resumption.
8. **Reconnect integrations.** User enters secrets/reauthorizes; verifies agent installations and browser sign-ins through their own flows.
9. **Keep automations disabled initially.** User reviews schedules, missed-run handling and delivery state before enabling them.
10. **Run a safe acceptance tour.** Start with disposable projects; avoid sending duplicate real tool actions while comparing apps.
11. **Promote the profile deliberately.** Record successful migration only after checks complete. Re-running the wizard must be idempotent and must not duplicate imported threads/runs.
12. **Retain recovery materials.** Define a user-visible retention/deletion decision for the original app/profile and backups; never silently delete them at first launch.

Migration bookkeeping should distinguish not-started/copying/validated/committed states. A crash during import must leave a resumable or discardable destination, not an ambiguous partially promoted profile.

### Blob and schema details

- Existing migrations are numbered through 31; preserve their numbering and compatibility checks before introducing new migrations.
- Additive schema changes do not automatically make an old app safe to write a new profile.
- Mirror legacy `session_id` behavior where needed; preserve per-agent bindings and last-seen/sequence checkpoints.
- Write blob bytes atomically and durably enough for the selected policy before committing a database reference. Recover/clean orphan blobs only after validating the snapshot.
- Preserve the current 65,536-byte tool payload offload boundary and preview/stub format with tests.
- SQLite snapshots do not include external blob/JSONL files; backup coordination is part of the application, not just a SQL operation.

### Rollback is not “copy the database back”

- Reopen the preserved old app/profile for the preserved baseline. Do not point it at an unverified newer schema.
- To retain new Rust conversations in the old app, implement and test a compatible backward export; otherwise disclose that rollback returns to the pre-cutover history.
- Project edits, untracked/staged files, Git commits/worktrees, browser actions, and remote deliveries live outside that profile snapshot.
- Use disposable repositories for differential tests. For a real cutover, record authorized project/worktree baselines and recovery instructions without destructive automatic reset/clean commands.
- Stop Rust processes/schedulers before returning to the old app. Do not let both hosts use one external agent session or execute an automation simultaneously.
- Sent messages, pushes, remote tools, and payments cannot generally be undone. Treat uncertain external results as uncertain, not safe to retry blindly.

## 11. Security requirements

Rust reduces certain memory-safety risks in Rust-owned code. It does not make native FFI, browser engines, model output, schemas, or shell commands trustworthy.

### Separate trust domains

| Surface | Allowed access | Must not receive |
|---|---|---|
| Bundled trusted app UI | Explicit application commands and scoped subscriptions | Blanket shell/filesystem/SQL permissions |
| Arbitrary-site browser | Network browsing and user-approved agent actions | App IPC, provider vault, filesystem access beyond deliberate user actions |
| Generated design/artifact content | Scoped local assets and explicitly allowed script behavior | App commands, browsing credentials, unrestricted network/local paths |
| Office/script workers | Bounded input and narrow broker requests | Ambient credentials, arbitrary direct native filesystem/network/process access |
| Remote MCP/provider input | Validated protocol messages routed through runtime policy | Automatic trust based only on schema validity or tool annotations |

### Tauri-specific controls

- Configure CSP deliberately; it is not enabled by wishful thinking. WASM may need `'wasm-unsafe-eval'`, not unrestricted `'unsafe-eval'` [T10].
- Registered application commands are allowed across app windows/webviews by default unless explicitly constrained through the app command manifest/permissions. Use explicit allowlists [T11].
- Capability overlaps merge. Do not add broad wildcard capabilities while debugging and leave them enabled.
- Remote content gets no application permissions. Linux cannot always distinguish iframe IPC from its containing window: do not rely on iframe identity as the only boundary [T11].
- Keep untrusted generated content in a demonstrably unprivileged view/context without initialization IPC bindings. Test parent/frame/origin and navigation attacks in the actual engine.
- Do not expose sensitive payloads through global broadcasts. Restrict event/channel consumers and verify backend authorization.
- CEF contexts and independent loopback servers need their own authorization/isolation; Tauri ACLs do not cover them automatically.

### Runtime controls

- Canonicalize authorized paths and defend against traversal, symlink escapes, alternate separators, UNC/device paths and case behavior.
- Deny archive traversal/absolute entries; bound compressed and decompressed work; reject unsafe external document relationships.
- Escape/sanitize model-generated HTML and validate rich UI blocks. Sanitization does not replace a sandbox.
- Keep local MCP on loopback with per-launch authentication, request limits and scoped project/thread ownership. Validate host/origin behavior against cross-origin and DNS-rebinding access.
- OAuth needs PKCE, state/issuer/resource checks, safe callback lifecycle, refresh handling and secure persistence. Library support is not the complete application flow.
- Review redirects, private/link-local IP targets, DNS changes, custom headers and proxy/TLS configuration for backend link/image/provider/MCP fetches. Local dev browsing is a deliberate capability, not an excuse for unrestricted backend SSRF.
- Redact secrets across streaming chunk boundaries and structured logs/errors/events. The current per-delta redaction limitation should become a security regression test, not be silently inherited.
- Keep browser debugging interfaces private: prefer native in-process interfaces/controlled pipes where viable. An open CDP port is a privileged control surface, not a harmless dev endpoint.
- Maintain a native dependency/SBOM/license/update register and review unsafe/FFI boundaries. A clean Rust build is not a vulnerability scan.

## 12. Tests, platform QA, and performance

### Current checks to preserve

These are the repository's existing commands, listed verbatim as future baseline checks. **They were not run for this documentation-only task.**

```sh
bun run typecheck
bun run design:check
bun run test
bun run build
bun run smoke
```

Important: Bun can load `.env` automatically; live tests in the default test tree are gated by key availability, not universally offline. Run future checks in a deliberately clean, approved environment that prevents credential loading and paid calls. Do not run the `eval` scripts against ambient credentials; those commands explicitly use an environment file and need separate approval.

The current CI runs typecheck/design/tests/build with Node 22 and Bun, PR Windows/Ubuntu plus extras, and optional macOS. Markdown-only PRs are ignored by that workflow. The migration needs explicit documentation checks and actual macOS/native integration coverage, not an assumption that a Markdown change triggered CI.

### Proposed Rust check commands

**Examples for the planned workspace; not executable claims about this repository today.** Package names/features must match the implemented manifests. Install native prerequisites first.

```sh
cargo +1.99.1 fmt --all -- --check
cargo +1.99.1 test -p cubiq-core -p cubiq-runtime --locked
cargo +1.99.1 clippy -p cubiq-core -p cubiq-runtime --all-targets --locked -- -D warnings
cargo +1.99.1 check -p cubiq-ui --target wasm32-unknown-unknown --locked
cargo +1.99.1 clippy -p cubiq-ui --target wasm32-unknown-unknown --locked -- -D warnings
```

Build/check the Tauri package and worker binaries separately with their selected native features/targets. Build packaged frontend assets with a pinned compatible WASM bundler before packaging. Add a real packaged smoke harness; do not pretend `cargo test` starts every native window/worker.

Avoid a blanket `cargo test --workspace --all-features`: native/WASM graphs and mutually exclusive CSR/SSR/renderer features can make that invalid. Check the supported feature matrix explicitly.

### Test layers

| Layer | Checks |
|---|---|
| Pure rules/DTOs | Permission and capability differences; golden JSON; null/unknown values; prompt/tool stability |
| Storage | All supported schema fixtures, interrupted/idempotent imports, WAL backup, FTS5, blobs, JSONL, FK/integrity |
| Provider/protocol | Fake HTTP/SSE, fragmented UTF-8/tool JSON, errors/retries, usage, unknown notifications, resume/interrupt |
| Tools/processes | Temporary repos/files, quoting/symlinks, PTY resize/full-screen/Unicode, stuck workers and descendants |
| MCP/OAuth | Stdio, Streamable HTTP JSON/SSE, legacy SSE, discovery/refresh/callbacks, malformed/large schemas |
| UI reducer/rendering | Recorded streams, long histories, nested tools, approvals, drafts, scroll/focus/selection, rich blocks |
| Real desktop | Native commands, assets, browser engine, lifecycle, menus/dialogs, sandbox boundaries, workers |
| Packaging/updates | Install/upgrade/uninstall, signing, updater signatures, offline/locked files, interruption/rollback |
| Authorized live checks | Actual installed agent compatibility and model/tool workflows with isolated accounts/projects |

### Differential and stress tests

- Feed the same fake agent/provider stream into old and new implementations; compare normalized canonical events and tool results, not non-deterministic timestamps.
- Generate schemas/profiles across supported migrations, including missing blobs, torn JSONL tails, absent/unknown usage and damaged imports.
- Reload/close the UI at every meaningful lifecycle state: live streaming, pending permission, compaction, active child, tool completion and queued messages.
- Cancel during an approval, browser lock wait, OAuth callback, PTY output burst, script Promise, Office parse and shutdown.
- Verify no stale request/turn generation executes privileged work and no duplicate scheduled run/delivery appears.
- Stress large tool output, long transcripts and many concurrent threads using synthetic fixtures; choose sizes from measured product use, not invented claims about current data.
- Compare prompt/tool serialization and usage/cache accounting to detect migration-induced model behavior changes.

### Browser/E2E tooling limits

Current Tauri documentation recommends WebdriverIO with embedded test plugins for Windows/Linux/macOS [T12]. Stock `tauri-driver` driven directly supports Windows/Linux, not WKWebView on macOS. Do not repeat an outdated blanket claim that macOS Tauri automation is impossible.

Embedded test plugins are development-only and must be excluded from production [T13]. Mocked IPC tests do not run the real Rust backend or webview. A Tauri DOM test does not automatically cover an independently embedded CEF pane, native dialogs, real PTYs, or installer behavior; add engine/platform-specific checks.

Node/JavaScript test tooling can remain a documented development dependency without making it a production application sidecar.

### Minimum real-host QA matrix

- Windows: intended Windows 10/11 versions, native caption/Mica fallback, MSVC/WebView2/CEF resources, PowerShell/Git Bash, ConPTY and Job Objects.
- macOS: Apple Silicon and Intel if retained, actual minimum releases, signing/notarization/helper behavior, traffic lights/zoom, clipboard/IME and wake/activation.
- Linux: supported distribution/glibc baseline, WebKitGTK dependencies, X11/Wayland decision, sandbox, secret-service availability, AppImage/native-library behavior.
- All: light/dark/system theme, existing motion/reduced-motion semantics, keyboard/focus, 900 px window with panel, narrow chat, long paths/Unicode, offline recovery and complete shutdown.

Tauri/toolchain/native-engine requirements must intersect. Old prerequisite pages mentioning Windows 7 are not a support promise for the latest Rust/CEF stack. macOS ARM64's Rust floor also does not establish the selected CEF minimum. Validate the complete bundle.

### Performance acceptance

Collect old/new measurements on the same machines, profiles and workloads:

- Cold/warm launch to interactive UI; first thread/history load; FTS search latency.
- Entire process-tree idle RAM/CPU and busy streaming/browser/design/terminal RAM/CPU.
- Installer/download/on-disk size, including browser engine, helpers, workers and bundled external binaries.
- Scroll/render responsiveness, queue depth, dropped/resynchronized live data, database stalls.
- PNG/PDF/Office rendering latency, cache behavior, shutdown duration and orphan count.

Set thresholds after Phase 0 measurements. No percentage savings are claimed here. If the migration is justified mainly by footprint and the full bundle is worse, reconsider scope before proceeding further.

## 13. Packaging and upgrades

Current packaging uses DMG/ZIP on macOS, NSIS on Windows, AppImage on Linux, and GitHub/electron-updater metadata. Claude/node-pty binaries are unpacked from ASAR; resources include skills, guides and design systems.

Rust/Tauri replacements need an explicit resource manifest for fonts, icons/splash assets, skills, guides, experts/design systems, browser resources/helpers, worker binaries and optional native libraries. Current startup expects packaged experts while the inspected builder `extraResources` list has no corresponding entry: **verify that discrepancy**, do not assume either existing breakage or successful packaging.

### Installer/update requirements

- Preserve product identity/file associations deliberately. `dev.aiharness.app` is the current builder ID; changing or retaining it needs an upgrade/data/OS-identity decision, not a secret-decryption assumption.
- Tauri updater metadata/signatures are not interchangeable with Electron `latest*.yml`.
- Choose a tested final Electron bridge release or an explicit manual installer handoff. Do not point old Electron clients at arbitrary Tauri artifacts.
- Tauri requires signed updater artifacts, separate from OS code signing, and production TLS by default [T14].
- macOS requires the chosen Developer ID/notarization/helper signing path [T15]. Windows signing does not guarantee immediate SmartScreen reputation, even with EV [T16].
- Include helper/sidecar architecture suffixes, permissions, license notices and supported engine versions; test launched resources from an installed bundle, not only a development tree.
- Release-signing material belongs in the authorized release process. This task neither requires nor reads it.
- Stage preview/beta/stable channels; never silently run production migrations from a development build.

Upgrade tests must include clean install, old app upgrade, old/new coexistence with separate profiles, attempted downgrade, offline download, bad/missing signature, interrupted update, locked files, failed migration, and recovery. Uninstall must not silently remove user projects or the only backup.

## 14. Effort, risks, and decisions

### Planning estimate, not a measured delivery promise

This is a sizeable desktop-product rewrite, not a weekend Tauri conversion. A reasonable provisional budget is **roughly 10–18 months for one experienced developer**, or **6–10 months for a small experienced team of three or four**, with meaningful runtime/UI parallelism after feasibility gates. Learning Rust, limited platform access, complex CEF integration or unsupported Claude controls can extend it substantially.

These ranges are planning assumptions. No source-LOC productivity model, complete test count, measured rewrite velocity, or vendor support commitment was established. Re-estimate after the feasibility stage and the first complete vertical slice.

| Work package | Directional effort | Main source of uncertainty |
|---|---|---|
| Baseline/contract fixtures | Medium | Capturing real behavior without live-data/credential exposure |
| Browser/Claude/data/UI spikes | High, first 3–6 weeks of evidence | Native embedding, control protocol, authorization, target machines |
| Runtime/storage/providers/adapters | High | Existing semantics, recovery, protocol drift and cache/accounting |
| Native tools/browser/design/previews | Very high | Engine packaging, terminal renderer, Office conversion, worker isolation |
| Skills/memory/teams/learning/scheduling | High | Less-visible dependencies, replay fidelity, side effects |
| Rust UI parity | Very high | Deep histories, custom components, responsive/native behavior |
| Migration/release/hardening | High | Three OSes, old-client update route, data rollback and security |

Avoid adding every table row as a sequential calendar estimate. Team work can overlap, but browser/Claude decisions, stable contracts, and release/migration gates are on the critical path.

### Risk register

| Risk | Impact | Mitigation / stop rule |
|---|---|---|
| Tauri cannot replace Chromium/CDP pane | Critical | Gate A; CEF/host fallback or explicitly approved UX reduction |
| Claude adapter lacks required controls or authorized product use | Critical | Gate B; compatibility ledger/vendor clarification, no hidden permanent Node bridge |
| Data/cursor/blob loss | Critical | Preserve schema, quiescent snapshots, differential fixtures, idempotent clone import |
| Secrets/browser sessions cannot migrate | High | Re-entry/reauthorization/relogin default; original encrypted profile untouched |
| Native worker/browser vulnerabilities | Critical | Sandbox/isolation tests, limits, patch ownership, native/FFI review |
| Terminal/Office/diagram parity underestimated | High | Representative early proofs; explicit dependency/fidelity decisions |
| Concurrent stale approvals/actions | Critical | Generation-scoped decisions, broker revocation, takeover barrier, cancellation tests |
| Protocol or engine versions drift | High | Tested version policy and release-matched fixtures/security updates |
| Rewrite changes prompts/usage/model behavior | High | Stable schema/prefix/memory serialization and replay/accounting checks |
| Upgrade strands Electron users | High | Tested bridge/manual handoff, backward export decision, rollback rehearsal |
| Rust/CEF still large or slower | Medium–high | Measure complete process tree and re-evaluate footprint objective |
| Rewrite competes with ongoing features | High | Freeze migration baseline per slice, separate product work, no silent scope creep |

### Decisions needed before implementation

1. Does “full Rust” mean Rust-owned runtime/UI with declared engines/glue, or literally all first-party source in Rust? Are xterm/Mermaid/page-JS exceptions allowed?
2. Is the **in-app browser pane mandatory**? If so, external Chrome is not an acceptable completion fallback.
3. Is Tauri mandatory, or is a Rust-owned CEF desktop shell acceptable if embedding two engines fails?
4. Which OS/CPU combinations and minimum OS versions must remain supported?
5. Is user re-entry of provider secrets, OAuth reauthorization and browser sign-in acceptable?
6. What Claude product/authentication experience is intended, and what approval/support clarification is required?
7. What Office/terminal/diagram fidelity is required beyond the actual source baseline?
8. Must new Rust turns be exportable back to the old app during beta, or is rollback to the preserved baseline acceptable?
9. Is the objective primarily maintainability/security ownership, footprint, or both? What measured regressions are acceptable?
10. What team/platform-testing capacity and feature-freeze window are available?

Defaults in this plan: preserve embedded browsing, preserve current design/features, accept reauthorization/relogin, do not add mobile/cloud scope, and require explicit approval for permanent JS widgets or reduced behavior.

## 15. First ten working days

This is a concrete start, **not a promise to complete all feasibility work in ten days**.

| Day | Concrete output |
|---|---|
| 1 | Approved scope, source revision, dirty-tree record, OS/CPU decision list and fixture privacy rules |
| 2 | API/event/capability inventory; one golden transcript/profile fixture; current baseline-check results from an approved clean environment |
| 3 | Small Leptos/Tauri shell using existing CSS/fonts, and first embedded CEF layout prototype |
| 4 | Browser input/focus/resize/takeover tests; record message-loop and sandbox problems rather than hiding them |
| 5 | Early Windows/Linux/macOS browser packaging evidence, or a documented platform-access blocker |
| 6 | Rust Claude streaming/control prototype and public/experimental interface ledger; initiate product-auth clarification |
| 7 | Approval/plan/question/resume/interrupt fixtures, including late responses and child output |
| 8 | Rust SQLite synthetic migration/FTS/blob proof and native secret-store re-entry design with disposable credentials |
| 9 | Long-history Leptos UI + terminal/Office/QuickJS representative proofs; record missing renderer/converter work |
| 10 | Review evidence; choose browser/host/UI route, enumerate unresolved gates and revise budget; authorize only the next concrete slice |

If only one developer is available, browser and Claude work will take longer than parallel team work. If platform hardware or vendor answers are unavailable, keep those gates open—do not mark them passed from a macOS-only prototype.

Useful subsequent implementation briefs should be narrow:

- “Port core DTO serialization against these fixtures; do not alter historical event JSON.”
- “Implement the existing SQLite migrations and blob threshold against synthetic profiles; do not import real credentials.”
- “Implement this provider SSE decoder and interruption/retry fixtures; do not change prompt/tool order.”
- “Port this one UI slice using `DESIGN.md` tokens; verify streaming, keyboard and narrow layouts.”

Each brief names the exact source/new files, allowed changes, tests, platform expectations and rollback boundary. Avoid “rewrite the app in Rust” as one undifferentiated implementation task.

## 16. Completion checklist

Do not call the port complete until all of these are accepted:

### Product parity

- [ ] Projects/Chats, threads/history/pins/archive/queues/search and agent handoff/resume/loss recovery.
- [ ] Existing provider wire formats and Claude/Codex/ACP workflows, capabilities, model/effort/context/usage.
- [ ] Approvals, plans, questions, guards, reliability checks and cancellation without stale execution.
- [ ] Skills/Library, MCP transports/gateway/OAuth/routing and private credential handling.
- [ ] Embedded browser/picking/automation/logs/screenshots/takeover with approved platform behavior.
- [ ] Design pages/variants/board/flow/presentation/references/drawing/comments/editing/versions/export.
- [ ] Artifacts/files/source/diff/versions, Office/PDF/image previews and editor integration.
- [ ] Git/worktree review/commit/merge/push/safe removal, PTY and background shell lifecycle.
- [ ] Memory, experts/teams, learning/replay/budgets, automations/Message Center and wake behavior.
- [ ] Rich UI/Markdown/diagrams, diagnostics/settings/splash/About/native window/update behavior.
- [ ] Current design tokens/fonts/theme/spacing/responsive/zoom/motion/keyboard behavior preserved.

### Implementation and operations

- [ ] No Electron production host, React first-party UI, TypeScript business runtime or Node application sidecar remains.
- [ ] Runtime-used eval/replay code is Rust; any development-only legacy tests/tooling are explicitly classified.
- [ ] Host/page JS bridges and third-party widgets have an approved, bounded dependency register; language claims match reality.
- [ ] External engines/agents/scripts/native libraries have version, license, security/update and packaging ownership.
- [ ] Data import/backup/restore/interruption and rollback/backward-export promises have actual test evidence.
- [ ] Secrets unavailable/locked paths fail safely; re-entry/reauthorization is understandable and tested.
- [ ] One writer/executor/scheduler per profile, correct subscription recovery, bounded resources and complete process cleanup.
- [ ] Real Windows/macOS/Linux installers, signed updates and failure/downgrade paths are tested.
- [ ] Security and performance results are measured on the complete bundle; remaining limits are documented.
- [ ] No unresolved critical browser/Claude/data/security gate is hidden behind a “Rust port finished” label.

## 17. Research sources and limits

### How to read the evidence

- **Observed facts:** source/manifests referenced in Section 3 and subsystem sections. Line ranges reflect the inspected checkout and can move.
- **Public research facts:** official release metadata, vendor/protocol documentation and versioned crate docs below, checked 21–22 October 2026.
- **Proposals:** architecture, selected libraries, phases, commands and migration policy. No combined Rust build or prototype was executed for this plan.
- **Estimates:** staffing/timing ranges are provisional planning assumptions, not benchmark or productivity measurements.

Key source groups:

| Topic | What the sources establish |
|---|---|
| Rust releases | Current verified compiler, edition distinction, stable-channel verification [R1], [R2], [R3] |
| Tauri releases | Independently versioned stable packages and registry/release evidence [T1], [T2], [T3], [T4], [T5], [T6] |
| Tauri architecture/security | Static frontend, system engines, channels, CSP and default command/capability boundaries [T7], [T8], [T9], [T10], [T11] |
| Rust UI | CSR/WASM and alternative renderer/license tradeoffs; not CubiQ feature parity [L1], [L2], [L3], [L4], [L5], [L6], [L7] |
| Agents | Supported SDK/CLI routes, control/permission caveats, authentication conditions and protocol boundaries [A1], [A2], [A3], [A4], [A5], [A6], [A7], [A8] |
| Browser | CEF embedding/native control, Rust binding candidate, CDP client and profile/headless limitations [B1], [B2], [B3], [B4], [B5], [B6], [B7] |
| MCP/data | Official Rust SDK/legacy SSE gap, schema validator, SQLite/WAL/backup/FTS constraints [M1], [M2], [D1], [D2], [D3], [D4] |
| Native integrations | Secret-store differences, PTY/state/Job Objects, parsing and script-engine limits [S1], [S2], [S3], [P1], [P2], [P3], [O1], [O2], [O3], [O4], [O5], [Q1], [Q2], [Q3] |
| Release/testing | Current WebDriver routes/test-only instrumentation and updater versus OS signing [T12], [T13], [T14], [T15], [T16] |

Remaining research limits:

- No migration, runtime parity test, performance benchmark, native bundle test, or full existing suite was run for this documentation task.
- No credential files, live profiles, personal sessions or signing keys were opened.
- No complete dependency/license/security audit or exact source-size/test-count measurement was performed.
- Claude raw-host support/authorization, CEF integration/target availability, terminal and Office fidelity, native secret-store behavior and backward export remain gates.
- Web/vendor documentation can drift; revalidate against chosen releases and actual target engines rather than relying on “latest” pages forever.
- The plan identifies a plausible route, not a vendor guarantee or unconditional claim that a full port will preserve every behavior without additional engineering.

[R1]: https://blog.rust-lang.org/2026/10/15/Rust-1.99.1/ "Announcing Rust 1.99.1, 15 October 2026"
[R2]: https://blog.rust-lang.org/2025/02/20/Rust-1.85.0/ "Rust 1.85 and Rust 2024"
[R3]: https://static.rust-lang.org/dist/channel-rust-stable.toml "Rust stable-channel distribution manifest"
[T1]: https://github.com/tauri-apps/tauri/releases/tag/tauri-v2.12.5 "Tauri 2.12.5 release; registry: https://crates.io/api/v1/crates/tauri/2.12.5"
[T2]: https://crates.io/api/v1/crates/tauri-build/2.7.4 "tauri-build 2.7.4 registry metadata"
[T3]: https://crates.io/api/v1/crates/tauri-cli/2.12.4 "tauri-cli 2.12.4 registry metadata"
[T4]: https://registry.npmjs.org/@tauri-apps/cli/latest "Public Tauri npm CLI latest metadata"
[T5]: https://registry.npmjs.org/@tauri-apps/api/latest "Public Tauri npm API latest metadata"
[T6]: https://v2.tauri.app/develop/updating-dependencies/ "Tauri package/plugin version matching"
[T7]: https://v2.tauri.app/start/frontend/ "Tauri static frontend hosting"
[T8]: https://v2.tauri.app/reference/webview-versions/ "Tauri platform webview engines"
[T9]: https://v2.tauri.app/develop/calling-rust/ "Tauri commands, channels and event behavior"
[T10]: https://v2.tauri.app/security/csp/ "Tauri CSP configuration"
[T11]: https://v2.tauri.app/security/capabilities/ "Tauri capabilities, command defaults and iframe limits"
[T12]: https://v2.tauri.app/develop/tests/webdriver/ "Tauri WebDriver routes; updated 29 June 2026"
[T13]: https://webdriver.io/docs/desktop-testing/tauri/plugin-setup "WebdriverIO Tauri test plugin setup"
[T14]: https://v2.tauri.app/plugin/updater/ "Tauri signed updater artifacts"
[T15]: https://v2.tauri.app/distribute/sign/macos/ "macOS code signing and notarization"
[T16]: https://v2.tauri.app/distribute/sign/windows/ "Windows code signing and SmartScreen caveats"
[L1]: https://docs.rs/leptos/0.8.22/leptos/ "Leptos 0.8.22 CSR/stable Rust API"
[L2]: https://v2.tauri.app/start/frontend/leptos/ "Tauri Leptos guide with older 0.6 recipe"
[L3]: https://docs.rs/yew/0.23.0/yew/ "Yew Rust/WASM UI"
[L4]: https://dioxuslabs.com/learn/0.7/guides/platforms/desktop/ "Dioxus desktop webview rendering"
[L5]: https://github.com/slint-ui/slint/blob/v1.18.1/LICENSES/LicenseRef-Slint-Royalty-free-2.0.md "Slint royalty-free license; also consider GPL/commercial options"
[L6]: https://docs.rs/egui/0.37.0/egui/ "egui native/immediate-mode UI"
[L7]: https://docs.rs/iced/0.14.0/iced/ "iced Rust native UI"
[A1]: https://code.claude.com/docs/en/agent-sdk/overview "Claude SDK language/subprocess and product-authentication guidance"
[A2]: https://code.claude.com/docs/en/cli-reference "Claude CLI flags and streaming interfaces"
[A3]: https://code.claude.com/docs/en/agent-sdk/typescript "Claude SDK controls and API reference"
[A4]: https://code.claude.com/docs/en/legal-and-compliance "Claude product/authentication conditions"
[A5]: https://code.claude.com/docs/en/agent-sdk/permissions "Claude permission evaluation and hooks"
[A6]: https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.284 "SDK stream-lifetime fix, 28 September 2026"
[A7]: https://developers.openai.com/codex/app-server/ "Codex app-server protocol and experimental boundaries"
[A8]: https://docs.rs/agent-client-protocol/3.4.0/agent_client_protocol/ "Official ACP Rust SDK candidate"
[B1]: https://chromiumembedded.github.io/cef/general_usage "CEF embedding, processes, message loops and packaging"
[B2]: https://github.com/chromiumembedded/cef/blob/master/include/cef_browser.h "CEF browser-host native input/DevTools interfaces"
[B3]: https://github.com/tauri-apps/cef-rs "Rust CEF binding candidate, not a proven Tauri replacement"
[B4]: https://docs.rs/chromiumoxide/0.9.1/chromiumoxide/ "Async Rust CDP client and handler model"
[B5]: https://developer.chrome.com/blog/remote-debugging-port "Chrome dedicated profile/debugging changes, 17 March 2025"
[B6]: https://developer.chrome.com/docs/chromium/new-headless "Chrome headless screenshot/PDF rendering"
[B7]: https://developer.chrome.com/blog/chrome-for-testing "Chrome for Testing update and intended-use caveats"
[M1]: https://raw.githubusercontent.com/modelcontextprotocol/rust-sdk/rmcp-v3.6.0/README.md "Official rmcp 3.6.0 capabilities and intentionally absent legacy HTTP+SSE transport"
[M2]: https://docs.rs/jsonschema/0.59.0/jsonschema/ "JSON Schema validation and retrieval configuration"
[D1]: https://docs.rs/rusqlite/0.40.2/rusqlite/ "Rust SQLite interface candidate"
[D2]: https://sqlite.org/wal.html "SQLite WAL snapshots, writer constraints and reset-bug fix"
[D3]: https://sqlite.org/backup.html "SQLite online backup API"
[D4]: https://sqlite.org/fts5.html "SQLite FTS5 compile/runtime requirements"
[S1]: https://www.electronjs.org/docs/latest/api/safe-storage "Electron OS/app-specific encryption semantics"
[S2]: https://docs.rs/keyring/4.2.0/keyring/ "Native keyring/core/platform-store guidance"
[S3]: https://v2.tauri.app/plugin/stronghold/ "Stronghold key-derived vault model"
[P1]: https://docs.rs/portable-pty/0.9.0/portable_pty/ "Rust PTY interfaces"
[P2]: https://docs.rs/alacritty_terminal/0.26.0/alacritty_terminal/ "Terminal state/grid library, not complete UI"
[P3]: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects "Windows process-group lifetime supervision"
[O1]: https://docs.rs/calamine/0.37.0/calamine/ "Spreadsheet reader candidate"
[O2]: https://docs.rs/csv/1.4.0/csv/ "CSV/TSV reader configuration"
[O3]: https://docs.rs/zip/9.0.5/zip/ "ZIP parser candidate"
[O4]: https://docs.rs/quick-xml/0.42.0/quick_xml/ "XML parser candidate and bounds/features"
[O5]: https://docs.rs/pdfium-render/0.9.4/pdfium_render/ "Existing-PDF APIs and separately supplied native PDFium"
[Q1]: https://docs.rs/rquickjs/0.14.0/rquickjs/ "Rust QuickJS binding candidate"
[Q2]: https://docs.rs/rquickjs/0.14.0/rquickjs/struct.AsyncRuntime.html "QuickJS runtime memory/interrupt controls and allocator caveat"
[Q3]: https://bellard.org/quickjs/quickjs.html "QuickJS engine API; not an OS sandbox"
