# design-kits

Design kits are HTML and CSS components that an AI agent composes pages from. They drop into a canvas that has no network and no build step: the files are read as text and put on a page as they are.

Each kit is written from scratch. It follows a library's look, but it is unofficial, not affiliated with or endorsed by that library. `components.json` records the real package import of each component for handoff only. Nothing here imports it.

## Layout

```
registry.json              kits, versions, themes, card tokens
kits/<kit-id>/
  index.md  DESIGN.md
  tokens.css  ui.css  ui.js
  components.json          data-ui, props, variants, snippet, package import
  blocks/*.html
  themes/<theme>/tokens.css
scripts/validate.mjs       schema, size limits, no remote URLs
```

## Validate

```
node scripts/validate.mjs [kit-id]
```

Run it from this folder. With no kit id it checks every kit in `kits/` and the registry. Add `--root <folder>` to check a different copy of this folder. It exits 0 when everything passes and 1 when something does not.
