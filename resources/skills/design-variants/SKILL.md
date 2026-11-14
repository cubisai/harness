---
name: design-variants
description: Write three in-place variants of the picked element (or of a new block at a gap) on a CubiQ design page, so the canvas can cycle them and keep one. Use when the message asks for 3 variants of, or beside, the selected element.
mode: design
---

# Three variants in place

1. **Identity.** Read the picked element in the page file (the message gives its selector), its parent, and the design's `system/` tokens. Note for yourself, in one sentence, what is on screen: surface and accent colours (real values), the fonts, the layout, corners, borders and shadows, and the copy's voice.
2. **Keep it** unless the message asks for a redesign: the same tokens and fonts. New tokens or fonts only on a redesign.
3. **Kit first.** When the element is built from kit parts (`data-ui`), reach for the kit before new markup: another variant or prop value of the same parts (`design_kit_inspect component:` lists them), other parts that fit (`search:`), a different block. Only props and values from `components.json`; new CSS only for what the kit can't express, with tokens, and never restyling a part through `[data-ui]`.
4. **Three axes.** Each variant commits to a different axis: hierarchy, layout, type, colour role, density or structure. The action below says which axes. Three tweaks of one axis is a failure. A note binds to the part it sits on. In the reference image, a loop means "this", an arrow a direction, a cross "remove".
5. **Write them in one edit**, in place of the element:

```html
<style data-cubiq-variants="SET">
@scope ([data-cubiq-variant="SET-1"]) { :scope > .card { … } :scope .title { … } }
@scope ([data-cubiq-variant="SET-2"]) { … }
@scope ([data-cubiq-variant="SET-3"]) { … }
</style>
<div data-cubiq-variant="SET-0" hidden><!-- the original element, unchanged --></div>
<div data-cubiq-variant="SET-1"><!-- variant 1 --></div>
<div data-cubiq-variant="SET-2" hidden><!-- variant 2 --></div>
<div data-cubiq-variant="SET-3" hidden><!-- variant 3 --></div>
```

   - `SET` is a short lowercase name of letters and digits (`hero`, `card2`) that isn't on the page yet.
   - Each wrapper holds exactly one element, with the original's tag and `data-agent-id`.
   - The wrapper is a layout-free shell (a `span` inside text or a heading). Style through `:scope > …` or `:scope …`, never a bare `:scope`.
   - Put shared keyframes in the same style block.
   - With several elements selected, wrap their nearest shared parent.
   - **Insert** (the message says "Insert … before/after"): the selected element is only the anchor and stays as it is. Write the set right beside it, with an empty `<div data-cubiq-variant="SET-0" hidden></div>`. Each variant is new content in the page's identity, with a new `data-agent-id`.
6. **Change nothing else.** Don't open or screenshot the page: the canvas is the preview.
7. **End the turn** with one line per variant: its axis and what changed.
