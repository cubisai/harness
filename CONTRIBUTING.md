# Contributing to CubiQ

Thanks for helping improve CubiQ. Focused bug fixes, tests, documentation, and accessibility improvements are welcome.

## Development setup

Install Node.js 22+, Git, and the Bun version declared in `package.json`, then run:

```bash
bun install --frozen-lockfile
bun run dev
```

`bun run preview:ui` starts the renderer with sample data at `http://localhost:5199`; no agent account is needed. This preview is not a substitute for checking Electron-specific behavior in the app.

## Repository layout

| Path | Purpose |
| :--- | :--- |
| `src/main/` | Electron main process, agent integrations, tools, and local storage |
| `src/preload/` | Typed bridge between the main process and renderer |
| `src/renderer/` | React desktop interface |
| `src/shared/` | Shared types and contracts |
| `resources/` | Bundled skills, guides, fonts, and design assets |
| `design-kits/` | Component kits and their assets |
| `test/` | Automated tests |
| `evals/`, `bench/` | Optional agent evaluations and benchmarks |
| `scripts/` | Build, validation, and maintenance scripts |
| `docs/design/` | Design-system reference and quality checks |

## Before opening a pull request

1. For larger changes, open an issue to discuss the approach first.
2. Keep the change focused and add tests for behavior changes.
3. Run the repository checks:

   ```bash
   bun run typecheck
   bun run test
   bun run design:check
   bun run build
   ```

4. Describe the change, how you tested it, and any platform-specific limitations. Include screenshots for UI changes.

Before editing `src/renderer/**`, read [`DESIGN.md`](DESIGN.md) and the [design reference](docs/design/README.md). Use the existing tokens and components. If tokens change, regenerate the reference with `bun run design:docs` before running `bun run design:check`.

## Optional evaluations

Evaluations can call real agents and incur charges. They are not required for a normal contribution. Never run them using someone else’s credentials or include private project data in reports.

- `bun run bench --dry` lists benchmark tasks without running an agent.
- [`bench/README.md`](bench/README.md) explains benchmark configuration and local reports.
- `bun run eval --agent claude --tier smoke --dry` previews an evaluation using the existing Claude integration.
- For a native provider evaluation, copy `.env.example` to `.env` and supply your own endpoint, model, and credentials. The template contains no real keys or account-specific defaults.

## Keep local data private

Do not commit API keys, `.env`, app profiles, screenshots of private projects, evaluation traces, or personal filesystem paths. Generated reports and local working notes are ignored. Sample data should use clearly fictional names and paths.

For security-sensitive issues, follow [`SECURITY.md`](SECURITY.md). Release and signing instructions are in the [README](README.md#releases).
