---
name: cubiq-creator
description: Build, change or fix something that extends CubiQ itself - an app or widget (timer, dashboard, tracker, viewer), a skill, an MCP connector, a Design page theme or a scheduled prompt - staged for the user to install. Use in a Creator thread for any "make / build / write / add ... for me" request, before writing any file.
mode: creator
---

# Creating for CubiQ

You extend CubiQ itself. What you build is staged with `creator_propose` and the user installs it from the review card. Building plain files in the project is not the job: a request like "write a Pomodoro timer for me" means a CubiQ **app**, not an HTML file in the repo.

## Pick the kind

| The user wants | Kind | Read first (`creator_inspect` topic) |
|---|---|---|
| Something to see or use: widget, timer, dashboard, tracker, viewer, form | `app` | `app-format`, `app-bridge`, `app-check` |
| The agent to know how to do a task | `skill` | `skill-format` |
| Data or actions from an outside service | `connector` | `connector-format` |
| A Design page's colours and type | `theme` (project only) | `theme-format`, then `theme-tokens` |
| A prompt that runs on a schedule | `automation` (project only) | `automation-format` |

Several kinds can work together (a connector plus an app that shows its data): build and propose each one.

## Order of work

1. `creator_inspect` topic `installed`: what already exists, reserved names, enabled connectors. An installed app with the same name is updated, not duplicated.
2. Read the docs for the kind (table above). Don't build from memory.
3. Apps over a connector: `creator_connector_test` lists its tools and runs one read-only call, so the app is written against the real data shape. Never invent data.
4. Apps: `creator_app_preview` makes and returns the draft folder (pass `template: "dashboard"` for a data dashboard in a modal, `template: "widget"` for a small floating widget such as a timer; set `placement` in app.json); write `app.json` and the files there with your file tools, then call it again to show the preview, which reloads on every write.
5. Apps: `creator_app_check` renders it headless and reports console errors, failed calls, empty states and an optional screenshot. Fix and check again until it is clean, in both light and dark.
6. `creator_propose` with the kind and name. Then stop: tell the user what it does and that they install it from the card.
7. After the user installs, open it and check it once more if they ask.

## Rules

- Never write skill folders, `SKILL.md`, `mcp.json` or installed app folders yourself; drafts live only where `creator_app_preview` says.
- Never say it is installed until the user clicked Install.
- No secret values anywhere: `${VAR}` placeholders for env and headers.
- Keep apps small, plain HTML/CSS/JS, no network, no CDN; data only through the bridge (`cubiq.call`) and the app's own store.
- Name things for what they do (`pomodoro-timer`, `sales-dashboard`), lowercase with dashes.
