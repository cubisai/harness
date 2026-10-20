# Link chips in agent replies (owner's pick 2026-10-20: inline chips, "like OpenAI ChatGPT")

## Today (verified)
- `src/renderer/src/markdown.tsx:149` `INLINE` only links `[label](https://…)`, rendered as a plain `<a>` (`:193`). Bare `https://…` URLs stay plain text.
- `src/main/link-preview.ts` fetches only pictures (`og:image` or the image itself) for `ui:cards` rows, over IPC `ui:image` (`src/main/index.ts:1394`), gated by Settings › Load link previews (`settings.linkPreviews`, default off). Fetch rules: public https only, DNS-checked socket, redirects re-checked, size caps, LRU 200.

## Design
1. **Chip** (renderer, `markdown.tsx` + a small `LinkChip` component): every https link in a reply renders as an inline pill: favicon (or a globe icon) + text. Text = the link's label; when the label is the URL itself, or the link is a bare URL, the site name (`og:site_name`, else the host without `www.`). Still an `<a>`: click opens it externally as now; copy keeps the URL. Truncates at ~28ch with an ellipsis; the full URL is in `title`.
   - Bare `https://…` URLs in text become chips too (trailing `.,;:!?)` not included).
   - Code spans/blocks and file links are untouched.
2. **Hover card**: after 300 ms hover/focus, a small popover (DESIGN §5 float shadow, radius 10): favicon + site name, title (2 lines), description (3 lines), host in mono `--text-tertiary`. Esc/leave closes. Keyboard: focus shows it.
3. **Metadata** (main, `link-preview.ts`): `meta(url)` → `{ siteName, title, description, icon }` from the page `<head>` (≤ 512 KB, same fetch rules): `og:site_name`/`og:title`/`og:description`/`<title>`/`meta description`; icon from `<link rel~=icon>` (prefer PNG/ICO ≤ 64 KB) else `/favicon.ico`, as a data URL (raster + ico + svg-as-image only). Text capped (title 200, description 400 chars), entities decoded, plain text only (React escapes). Cached with the existing LRU (misses too). New IPC `ui:link-meta`, returns null unless Load link previews is on.
4. **Off (default)**: chips still render (globe icon + label/host), nothing is fetched, and the hover card shows only the host and full URL. On: favicon on render, title/description on hover.
5. **Streaming**: chips render in the frozen part only; the tail keeps plain text until it freezes (no fetch storm while typing). Renderer keeps a per-URL promise map so one URL is fetched once per session.
6. **Settings copy**: "Load link previews: favicons, titles and thumbnails for links in replies and card lists. Fetching tells those sites your IP address."

## Files
- `src/main/link-preview.ts` (+ `meta`, `pageMeta`, `faviconUrl` parsers), `src/main/index.ts` (IPC), `src/preload/*` + `src/shared/types.ts` (`LinkMeta`, `uiLinkMeta`).
- `src/renderer/src/markdown.tsx` (bare URLs, chip), new `src/renderer/src/components/LinkChip.tsx`, `src/renderer/src/styles/app.css` (`.link-chip`, `.link-card`, tokens only), `SettingsSheet.tsx` (copy).
- Tests: `test/link-preview.test.ts` (meta/favicon parsing, gating), `test/markdown*.test.tsx` (chip text rules, bare URLs, code untouched, streaming tail plain).

## Blast radius / no regressions
- Every reply with a link changes look; anchors stay anchors (copy, open, Markdown export unchanged). Card lists unchanged.
- No network unless the setting is on (pin with a test). Same SSRF rules as images (reuse `get`/`fetchableUrl`).
- Windows: no OS-specific code; favicon `.ico` decoding is Chromium's.
- DESIGN §9: light/dark, 900px, keyboard focus ring, reduced motion (hover card no animation), screenshot in dark.

## Shipped (2026-10-20)
- Owner feedback on the chips alone: "doesn't look like ChatGPT"; picked **rich link cards**. Added under each paragraph/list with https links: up to 3 cards (`LinkCards` in `LinkChip.tsx`, `linkUrls()` in `markdown.tsx`) with the page's `og:image` thumbnail (112×72), title, one-line description, favicon + site. `LinkMeta.image` added; a card draws only once its metadata (with a title) arrives, so with Load link previews off nothing shows and nothing is fetched. Inline chips + hover card stay.
- Live: 4 links → 4 chips with real favicons, 3 cards with thumbnails (vite.dev, react.dev, github.com); dark + light, 900px no sideways scroll.
