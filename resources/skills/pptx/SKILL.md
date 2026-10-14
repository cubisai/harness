---
name: pptx
description: Create or read PowerPoint presentations (.pptx) - build a slide deck with titles, bullets, images, tables and charts, or extract the text and notes from an existing deck. Use whenever the user wants slides or mentions a .pptx file.
---

# Presentations (.pptx)

## Packages: only these, only if missing

Allowed: `pptxgenjs@4.0.1` (create), `jszip@3.10.2` (read, edit XML). Nothing else; no icon packs or image libraries. If a task seems to need another package, stop and tell the user what and why.

```bash
node -e "const r=require('node:module').createRequire('<tmp>/harness-doc-tools/');r('pptxgenjs');r('jszip')" 2>/dev/null \
  || npm install --prefix "<tmp>/harness-doc-tools" --ignore-scripts --no-audit --no-fund pptxgenjs@4.0.1 jszip@3.10.2
```

Load with `createRequire("<tmp>/harness-doc-tools/")`. Write scripts with the **Write tool** (UTF-8), in the scratch folder, not through a PowerShell here-string (it turns `—` into `â€”`).

## Read

A .pptx is a ZIP. With `jszip`, take `ppt/slides/slideN.xml` in numeric order (not alphabetical: slide10 sorts before slide2) and collect `<a:t>` text per `<a:p>`; notes are in `ppt/notesSlides/`. Report slide by slide, with the title first.

## Plan the deck first

One message per slide; a title that states it as a sentence; at most 5 short bullets (or one visual); detail goes in speaker notes. Vary the layouts (title, two-column, big number, table, chart, quote); not every slide is title plus bullets. Every content slide has something visual (chart, table, image, big figure, diagram built from shapes).

Design: one font (Calibri or Arial; set it explicitly), two or three colours, one dominant. Sizes: title 32-40 pt, body 16-20 pt, captions 11-12 pt, never below 12 pt. Margins at least 0.5 in. Left-align body text. No accent lines under titles, no decorative bars.

## Create (`pptxgenjs`)

```js
const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE";            // 13.33 x 7.5 in; set BEFORE adding slides
pptx.defineSlideMaster({ title: "BASE", background: { color: "FFFFFF" }, objects: [] });
const s = pptx.addSlide({ masterName: "BASE" });
```

Rules (each one is a real corruption or silent-failure case):
- Colours are 6-digit hex without `#` (`"1F4E79"`); `#` or 8 digits corrupts the file. Transparency is `transparency: 0-100` on fills.
- Bullets: `{ text, options: { bullet: true, breakLine: true } }` on each item; never type `•`. Space with `paraSpaceAfter`.
- Spacing option is `charSpacing`; `letterSpacing` is ignored. Shadow `offset` must be >= 0.
- Charts are native: `s.addChart(pptx.ChartType.bar, [{ name, labels, values }], opts)`. On stacked bars, `dataLabelPosition` must be `ctr`, `inEnd` or `inBase` (`outEnd` corrupts).
- Notes: `s.addNotes("...")`, not a text box.
- Images: local `path` or `data:image/png;base64,...`; give `x, y, w, h` that keep the aspect ratio (`sizing: { type: "contain", w, h }`).
- Positions are inches and are not clamped: keep `x + w <= 13.33` and `y + h <= 7.5` (wide layout).
- Text fit is not computed: a 16 pt line holds roughly `width_in * 10` characters. If body text might exceed its box, shorten it or enlarge the box; `fit: "shrink"` only acts after PowerPoint opens the file, so don't rely on it.
- Save: `await pptx.writeFile({ fileName })`.

## Edit an existing deck

pptxgenjs cannot open files. For text changes, `jszip`: edit the slide XML (text is split across `<a:r>` runs; replace in the joined paragraph), zip, write `name.edited.pptx`. Do structure changes (add, delete, reorder) before editing content, and keep `[Content_Types].xml`, `ppt/_rels/presentation.xml.rels` and `<p:sldIdLst>` consistent. For anything bigger, rebuild the deck and say what was not carried over.

## Check before you say it is done

1. Re-open with `jszip`: list each slide's title and bullet count; none empty, no `TODO`/`lorem`/`xxx`/`[insert`, no `â€`.
2. Every slide's shapes inside the slide bounds (compute from your own `x/y/w/h` list in the script).
3. **Look at the slides** if a converter is already installed: `soffice --headless --convert-to pdf --outdir <tmp> deck.pptx`, `pdftoppm -png -r 60`, then open the PNGs with the image Read tool. Check text overflow first, then overlap, margins, contrast.
4. If you could not render the deck, say so in the answer; do not claim the layout is verified.
