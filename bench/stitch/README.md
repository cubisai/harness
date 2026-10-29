# Stitch taste references

Google Stitch screens used as a taste reference for design mode (not a bench of CubiQ). Key: `STITCH_API_KEY` in the
repo's `.env` (never in files, briefs or commits). Stitch is strictly rate-limited: one call at a time, generations are
never retried (on a transport error the runner polls `list_screens`), 429 backs off 2/4/8 min then stops.

- `node bench/stitch/flow.mjs <out> <prompt.md>...` runs a prompt file's 4-step Stitch workflow (Design.md, batches,
  unify, refines; format of `~/Documents/ai-agent/traning-data/*.md`). Resumable: `<out>/<id>/state.json`.
- `node bench/stitch/flow.mjs <out> --recover <projectId> <name>` downloads every screen of a project.
- `node bench/stitch/flow.mjs <out> --parse <prompt.md>...` dry-runs the parser (no calls; any STITCH_API_KEY value).
- `python3 bench/stitch/sheet.py out.png 1000 a.png b.png …` makes a contact sheet for review.
- `crafted.json`: 5 web + 5 mobile prompts written to the Stitch prompt guide (normal → complex).
