# Museum Label

## World
A gallery wall. The work hangs alone in a lot of white space; the label beside it is tiny, precise and set in a refined typeface. The interface steps back.

## Colour: restrained
- White `--color-bg`, near-black `--color-text`, `--color-text-muted` for captions.
- No colour in the chrome; the photographs or artworks bring it. `--color-accent` oxblood only for a single "available" or "sold" marker.

## Type
- `--font-display` Bodoni Moda for titles, large (96–120), weight 500; the italic for names of works.
- `--font-sans` Hanken Grotesk for captions and navigation at 12–14, generous letter-spacing 0.01em, sentence case.
- Captions follow the museum pattern: title (italic), year, medium, dimensions on separate lines.

## Layout
- Images lead: full-bleed or set on a wide off-centre column with large margins (96px+).
- An asymmetric index: works in a loose masonry or a single column with captions to the side.
- Navigation is a few text links at the top edge; nothing sticky.

## Components
- Link button: text with a 1px underline; one solid black 44px button for "Enquire", padding 0 `--space-6`.
- Image frame: no radius, no shadow, no border; caption below as a wall label (artist, title, year, medium).
- Lightbox: a black page in both schemes, image centred, caption below in light grey.

## Signature
The first viewport is one artwork at near-full height with the title in Bodoni at the edge, and nothing else.

## Rules
- Let the work and its label carry the page: image, then a wall-label caption (not cards or decorative backgrounds).
- Use one display face; italics for titles.
- Keep corners square and surfaces flat (not icons, gradients or hero metrics).
- Lint allows: italic-serif-display

## Motion
Images fade in slowly (600ms) once as they enter; hover shows the caption. Nothing else moves.
