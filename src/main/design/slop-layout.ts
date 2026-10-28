/// <reference lib="dom" />

import type { LintFinding } from "./lint";

/** A plain-data snapshot of one element for the layout slop rules. */
export interface LayoutSlopElement {
  selector: string;
  tag: string;
  width: number;
  height: number;
  left: number;
  right: number;
  /** A sized, rounded surface that reads as a panel. */
  card: boolean;
  /** A card somewhere in the six ancestors above this element. */
  nestedInCard: boolean;
  /** A small square icon tile over a painted or bordered surface. */
  iconTile: boolean;
  /** The next sibling is a heading, or a wrapper whose first child is one. */
  tileBeforeHeading: boolean;
  /** Space above a heading whose previous sibling is visible. */
  headingGapAbove?: number;
  /** Space below a heading whose next sibling is visible. */
  headingGapBelow?: number;
  /** Trimmed characters of text in the element. */
  textLength: number;
  /** Distance from the box edge to its own text, when it pads less than 16px. */
  textInsetPx?: number;
  /** Computed clip-path, including the -webkit- fallback. */
  clipPath: string;
  /** Computed mask-image, including the -webkit- fallback. */
  maskImage: string;
  /** The image src attribute, empty when absent. */
  src?: string;
  naturalWidth?: number;
  complete?: boolean;
  /** True when an opaque layer covers most of the image. */
  coveredByOverlay?: boolean;
  /** A sideways scroller whose first card touches its own left edge. */
  edgeFlushScroller: boolean;
}

/** A plain-data snapshot of page layout for the layout slop rules. */
export interface LayoutSlopSnapshot {
  viewportWidth: number;
  viewportHeight: number;
  /** Vertical gaps between consecutive visible block siblings. */
  gaps: number[];
  elements: LayoutSlopElement[];
}

/** Snapshot layout geometry and card/icon/text facts for the layout slop rules; runs inside the page. */
export function collectLayoutSlop(selectorFor: (el: Element) => string): LayoutSlopSnapshot {
  const skipTags: Record<string, boolean> = {
    script: true,
    style: true,
    path: true,
    g: true,
    defs: true,
    use: true,
    circle: true,
    rect: true,
    line: true,
    polyline: true,
    polygon: true,
    ellipse: true,
  };

  const elements: LayoutSlopElement[] = [];
  const gaps: number[] = [];
  const viewportWidth = Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0);
  const viewportHeight = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
  const body = document.body;
  if (!body) return { viewportWidth, viewportHeight, gaps, elements };

  /** The alpha channel of a computed color; -1 when the format is unknown. */
  const alphaOf = (value: string): number => {
    const text = value.trim().toLowerCase();
    if (!text || text === "transparent") return 0;
    const fn = /^rgba?\(([^)]*)\)$/.exec(text);
    if (!fn) return -1;
    const inner = fn[1]!.trim();
    const parts = inner.includes(",") ? inner.split(",").map((p) => p.trim()) : inner.split(/[\s/]+/).filter(Boolean);
    if (parts.length < 4) return 1;
    const alpha = Number.parseFloat(parts[3]!);
    return Number.isFinite(alpha) ? alpha : 1;
  };

  /** True when a computed background-color paints something. */
  const painted = (value: string): boolean => alphaOf(value) > 0;

  const normalize = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");

  const borderPx = (cs: CSSStyleDeclaration): { top: number; right: number; bottom: number; left: number } => ({
    top: Number.parseFloat(cs.getPropertyValue("border-top-width")) || 0,
    right: Number.parseFloat(cs.getPropertyValue("border-right-width")) || 0,
    bottom: Number.parseFloat(cs.getPropertyValue("border-bottom-width")) || 0,
    left: Number.parseFloat(cs.getPropertyValue("border-left-width")) || 0,
  });

  const shadowed = (cs: CSSStyleDeclaration): boolean => {
    const value = cs.boxShadow;
    return value !== "" && value !== "none";
  };

  const cardFrom = (el: Element, cs: CSSStyleDeclaration, rect: DOMRect): boolean => {
    const tag = el.tagName.toLowerCase();
    if (tag !== "div" && tag !== "article" && tag !== "section" && tag !== "aside" && tag !== "li" && tag !== "a") {
      return false;
    }
    if (rect.width < 160 || rect.height < 80) return false;
    const radius = Number.parseFloat(cs.borderTopLeftRadius) || 0;
    if (radius < 4) return false;
    const b = borderPx(cs);
    if (b.top >= 1 && b.right >= 1 && b.bottom >= 1 && b.left >= 1) return true;
    if (shadowed(cs)) return true;
    const background = cs.backgroundColor;
    if (!painted(background)) return false;
    let parent = el.parentElement;
    while (parent) {
      const parentStyle = getComputedStyle(parent);
      if (painted(parentStyle.backgroundColor)) {
        return normalize(parentStyle.backgroundColor) !== normalize(background);
      }
      parent = parent.parentElement;
    }
    return true;
  };

  const isCard = (el: Element): boolean => {
    try {
      return cardFrom(el, getComputedStyle(el), el.getBoundingClientRect());
    } catch {
      return false;
    }
  };

  const cardLookFor = (el: Element): boolean => {
    try {
      const cs = getComputedStyle(el);
      const b = borderPx(cs);
      return (
        b.top >= 1 ||
        b.right >= 1 ||
        b.bottom >= 1 ||
        b.left >= 1 ||
        shadowed(cs) ||
        painted(cs.backgroundColor)
      );
    } catch {
      return false;
    }
  };

  const all = body.querySelectorAll("*");
  const limit = Math.min(all.length, 3000);
  for (let i = 0; i < limit; i += 1) {
    const el = all[i];
    if (!el) continue;
    const tag = el.tagName.toLowerCase();
    if (skipTags[tag]) continue;
    // An unresolved variant set: only the shown variant is on the page.
    if (el.closest("[data-cubiq-variant][hidden]")) continue;
    try {
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      const b = borderPx(cs);
      const radius = Number.parseFloat(cs.borderTopLeftRadius) || 0;

      // Nested cards: remember whether a card sits within six ancestors.
      const card = cardFrom(el, cs, rect);
      let nestedInCard = false;
      if (card) {
        let parent = el.parentElement;
        for (let level = 0; parent && level < 6; level += 1) {
          if (isCard(parent)) {
            nestedInCard = true;
            break;
          }
          parent = parent.parentElement;
        }
      }

      // Icon tile stack: a small square icon tile immediately above a heading.
      let iconTile = false;
      let tileBeforeHeading = false;
      if (width >= 32 && width <= 72 && height >= 32 && height <= 72 && Math.abs(width - height) <= 4 && radius > 0) {
        const boxed = painted(cs.backgroundColor) || b.top >= 1 || b.right >= 1 || b.bottom >= 1 || b.left >= 1;
        if (boxed) {
          const ownText = (el.textContent ?? "").trim();
          const holdsIcon = el.querySelector("svg, img, i") !== null;
          if (holdsIcon || (ownText.length >= 1 && ownText.length <= 2)) {
            iconTile = true;
            const next = el.nextElementSibling;
            if (next) {
              const nextTag = next.tagName.toLowerCase();
              if (nextTag === "h2" || nextTag === "h3" || nextTag === "h4") {
                tileBeforeHeading = true;
              } else {
                const first = next.firstElementChild;
                if (first) {
                  const firstTag = first.tagName.toLowerCase();
                  if (firstTag === "h2" || firstTag === "h3" || firstTag === "h4") tileBeforeHeading = true;
                }
              }
            }
          }
        }
      }

      // Heading rhythm: the space above and below an h2 or h3.
      let headingGapAbove: number | undefined;
      let headingGapBelow: number | undefined;
      if ((tag === "h2" || tag === "h3") && height > 0) {
        const prev = el.previousElementSibling;
        const next = el.nextElementSibling;
        if (prev && next) {
          const prevRect = prev.getBoundingClientRect();
          const nextRect = next.getBoundingClientRect();
          if (prevRect.height > 0 && nextRect.height > 0) {
            headingGapAbove = Math.round((rect.top - prevRect.bottom) * 10) / 10;
            headingGapBelow = Math.round((nextRect.top - rect.bottom) * 10) / 10;
          }
        }
      }

      const textLength = Math.min((el.textContent ?? "").trim().length, 4000);

      // Text at the viewport edge: record paragraphs and list items near the edge.
      const textEdge =
        (tag === "p" || tag === "li") &&
        textLength >= 40 &&
        height > 0 &&
        (rect.left < 16 || rect.right > viewportWidth - 16);

      // Cramped padding: measure the first direct text child against the content edge.
      let textInsetPx: number | undefined;
      const boxed = painted(cs.backgroundColor) || (b.top >= 1 && b.right >= 1 && b.bottom >= 1 && b.left >= 1);
      if (boxed && width >= 120 && height >= 40) {
        let textNode: Node | null = null;
        for (let j = 0; j < el.childNodes.length; j += 1) {
          const child = el.childNodes[j];
          if (child && child.nodeType === 3 && (child.textContent ?? "").trim().length >= 2) {
            textNode = child;
            break;
          }
        }
        if (textNode) {
          const range = document.createRange();
          range.selectNodeContents(textNode);
          const textRect = range.getBoundingClientRect();
          if (textRect.width > 0 && textRect.height > 0) {
            const contentLeft = rect.left + b.left;
            const contentRight = rect.right - b.right;
            const inset = Math.min(textRect.left - contentLeft, contentRight - textRect.right);
            if (inset < 16) textInsetPx = Math.round(inset * 10) / 10;
          }
        }
      }

      // Jagged mask: a large shape cut by a polygon or a mask image.
      const clipPathValue = cs.getPropertyValue("clip-path") || "";
      const webkitClipPath = cs.getPropertyValue("-webkit-clip-path") || "";
      const clipPath = clipPathValue !== "" && clipPathValue !== "none" ? clipPathValue : webkitClipPath || "none";
      const maskValue = cs.getPropertyValue("mask-image") || "";
      const webkitMask = cs.getPropertyValue("-webkit-mask-image") || "";
      const maskImage = maskValue !== "" && maskValue !== "none" ? maskValue : webkitMask || "none";
      const jaggedCandidate =
        width >= 200 &&
        height >= 150 &&
        (clipPath.indexOf("polygon(") !== -1 || maskImage.indexOf("url(") !== -1);

      // Images: load state, and whether an opaque layer sits over the centre.
      let src: string | undefined;
      let naturalWidth: number | undefined;
      let complete: boolean | undefined;
      let coveredByOverlay: boolean | undefined;
      let broken = false;
      let imageWide = false;
      if (tag === "img") {
        const img = el as HTMLImageElement;
        // A srcset-only image is fine: its chosen source is currentSrc.
        src = el.getAttribute("src") || img.currentSrc || el.getAttribute("srcset") || "";
        naturalWidth = img.naturalWidth;
        complete = img.complete;
        broken = src.trim() === "" || (complete === true && naturalWidth === 0);
        imageWide = width >= 200 && height >= 150;
        if (imageWide) {
          try {
            const stack = document.elementsFromPoint(rect.left + width / 2, rect.top + height / 2);
            let imgIndex = -1;
            for (let j = 0; j < stack.length; j += 1) {
              if (stack[j] === el) {
                imgIndex = j;
                break;
              }
            }
            const stop = imgIndex === -1 ? stack.length : imgIndex;
            for (let j = 0; j < stop; j += 1) {
              const above = stack[j];
              if (!above || above === el || el.contains(above)) continue;
              const aboveStyle = getComputedStyle(above);
              if (alphaOf(aboveStyle.backgroundColor) < 0.8) continue;
              const aboveRect = above.getBoundingClientRect();
              const overlapWidth = Math.min(rect.right, aboveRect.right) - Math.max(rect.left, aboveRect.left);
              const overlapHeight = Math.min(rect.bottom, aboveRect.bottom) - Math.max(rect.top, aboveRect.top);
              if (
                overlapWidth > 0 &&
                overlapHeight > 0 &&
                (overlapWidth * overlapHeight) / (width * height) >= 0.8
              ) {
                coveredByOverlay = true;
                break;
              }
            }
          } catch {
            // Hit testing a detached or covered image is skipped.
          }
        }
      }

      // Edge-flush cards: a sideways scroller whose first card touches its edge.
      let edgeFlushScroller = false;
      if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 4) {
        const first = el.firstElementChild;
        if (first && (isCard(first) || cardLookFor(first))) {
          const firstRect = first.getBoundingClientRect();
          if (Math.abs(firstRect.left - rect.left) <= 2) edgeFlushScroller = true;
        }
      }

      // Monotonous spacing: gaps between this element's visible block children.
      if (gaps.length < 400) {
        const children = el.children;
        let previousBottom: number | null = null;
        for (let j = 0; j < children.length && gaps.length < 400; j += 1) {
          const child = children[j];
          if (!child) continue;
          const childTag = child.tagName.toLowerCase();
          if (skipTags[childTag]) continue;
          const childStyle = getComputedStyle(child);
          const display = childStyle.display;
          if (display === "none" || display === "contents" || display.indexOf("inline") === 0) continue;
          const childRect = child.getBoundingClientRect();
          if (childRect.height <= 0) continue;
          if (previousBottom !== null) {
            const gap = childRect.top - previousBottom;
            if (gap >= 4) gaps.push(Math.round(gap * 10) / 10);
          }
          previousBottom = childRect.bottom;
        }
      }

      const keep =
        card ||
        (iconTile && tileBeforeHeading) ||
        headingGapAbove !== undefined ||
        textEdge ||
        textInsetPx !== undefined ||
        jaggedCandidate ||
        (tag === "img" && (broken || imageWide)) ||
        edgeFlushScroller;
      if (!keep) continue;

      elements.push({
        selector: selectorFor(el),
        tag,
        width: Math.round(width),
        height: Math.round(height),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        card,
        nestedInCard,
        iconTile,
        tileBeforeHeading,
        headingGapAbove,
        headingGapBelow,
        textLength,
        textInsetPx,
        clipPath,
        maskImage,
        src,
        naturalWidth,
        complete,
        coveredByOverlay,
        edgeFlushScroller,
      });
    } catch {
      // One element never aborts the snapshot.
    }
  }
  return { viewportWidth, viewportHeight, gaps, elements };
}

/** Turn a layout snapshot into slop findings; pure and self-contained. */
export function layoutSlopFindings(s: LayoutSlopSnapshot): LintFinding[] {
  const findings: LintFinding[] = [];
  const push = (selector: string, id: string, detail: string): void => {
    findings.push({ rule: "slop", id, selector, detail });
  };

  // Nested cards: a panel drawn inside another panel.
  let nested = 0;
  for (const node of s.elements) {
    if (!node.card || !node.nestedInCard) continue;
    if (nested >= 3) break;
    nested += 1;
    push(node.selector, "nested-cards", "card nested inside a card: flatten the inner one to a plain group or a divider");
  }

  // Icon tile stack: small square icon tiles sitting above feature headings.
  const tiles: LayoutSlopElement[] = [];
  for (const node of s.elements) {
    if (node.iconTile && node.tileBeforeHeading) tiles.push(node);
  }
  if (tiles.length >= 3) {
    push(
      tiles[0]!.selector,
      "icon-tile-stack",
      `${tiles.length} icon tiles stacked above feature headings: drop the tiles or put the icon inline with the heading`,
    );
  }

  // Heading rhythm: a heading with less space above it than below.
  const rhythms: LayoutSlopElement[] = [];
  for (const node of s.elements) {
    if (node.tag !== "h2" && node.tag !== "h3") continue;
    if (node.height <= 0) continue;
    const above = node.headingGapAbove;
    const below = node.headingGapBelow;
    if (above === undefined || below === undefined) continue;
    if (below < 8 || above >= below) continue;
    rhythms.push(node);
  }
  if (rhythms.length >= 2) {
    const shown = Math.min(rhythms.length, 3);
    for (let i = 0; i < shown; i += 1) {
      const node = rhythms[i]!;
      push(
        node.selector,
        "heading-rhythm",
        `heading sits ${Math.round(node.headingGapAbove ?? 0)}px under the last block and ${Math.round(node.headingGapBelow ?? 0)}px over its own: put more space above a heading than below`,
      );
    }
  }

  // Monotonous spacing: the same gap between nearly every pair of blocks.
  if (s.gaps.length >= 12) {
    let mode = s.gaps[0] ?? 0;
    let modeCount = 0;
    for (const gap of s.gaps) {
      let count = 0;
      for (const other of s.gaps) {
        if (Math.abs(other - gap) <= 1) count += 1;
      }
      if (count > modeCount) {
        modeCount = count;
        mode = gap;
      }
    }
    if (modeCount / s.gaps.length >= 0.8) {
      push(
        "body",
        "monotonous-spacing",
        `the same ${Math.round(mode)}px gap between ${modeCount} of ${s.gaps.length} blocks: vary spacing to group related items`,
      );
    }
  }

  // Edge-flush cards: a sideways scroller whose first card touches its edge.
  let flush = 0;
  for (const node of s.elements) {
    if (!node.edgeFlushScroller) continue;
    if (flush >= 3) break;
    flush += 1;
    push(node.selector, "edge-flush-cards", "cards in a sideways scroller touch its edge: inset the first and last card");
  }

  // Text at the viewport edge: running text with no page side padding.
  let edgeText = 0;
  for (const node of s.elements) {
    if (node.tag !== "p" && node.tag !== "li") continue;
    if (node.textLength < 40 || node.height <= 0) continue;
    if (node.left >= 8 && node.right <= s.viewportWidth - 8) continue;
    if (edgeText >= 3) break;
    edgeText += 1;
    push(node.selector, "text-at-viewport-edge", "running text touches the window edge: give the page side padding");
  }

  // Cramped padding: text almost touching the edge of its own box.
  let cramped = 0;
  for (const node of s.elements) {
    const inset = node.textInsetPx;
    if (inset === undefined || inset >= 8) continue;
    if (cramped >= 3) break;
    cramped += 1;
    push(node.selector, "cramped-padding", `text sits ${Math.round(Math.max(0, inset))}px from its box edge: pad boxes at least 12px`);
  }

  // Jagged mask: a large shape cut by a many-point polygon or an image mask (a gradient mask is a fade, not an edge).
  const polygonPoints = (value: string): number => {
    const match = /polygon\(([^)]*)\)/.exec(value);
    if (!match) return 0;
    const parts = (match[1] ?? "").split(",");
    let count = 0;
    for (const part of parts) {
      const point = part.trim();
      if (point && !/^(evenodd|nonzero)$/i.test(point)) count += 1;
    }
    return count;
  };
  let jagged = 0;
  for (const node of s.elements) {
    if (jagged >= 2) break;
    if (node.width < 200 || node.height < 150) continue;
    const masked = node.maskImage.indexOf("url(") !== -1;
    if (polygonPoints(node.clipPath) < 6 && !masked) continue;
    jagged += 1;
    push(node.selector, "jagged-mask", "jagged clip-path on a large image or shape: use a plain rectangle or a real radius");
  }

  // Image overlay: an opaque layer hiding most of an image.
  let overlays = 0;
  for (const node of s.elements) {
    if (overlays >= 2) break;
    if (node.tag !== "img" || node.width < 200 || node.height < 150) continue;
    if (node.coveredByOverlay !== true) continue;
    overlays += 1;
    push(node.selector, "image-overlay", "an overlay hides most of this image: lighten it or drop the image");
  }

  // Broken image: an image with no source or one that failed to load.
  let brokenImages = 0;
  for (const node of s.elements) {
    if (brokenImages >= 4) break;
    if (node.tag !== "img") continue;
    const src = node.src ?? "";
    const broken = src.trim() === "" || (node.complete === true && node.naturalWidth === 0);
    if (!broken) continue;
    brokenImages += 1;
    const label = src.trim().slice(0, 40) || "(no src)";
    push(node.selector, "broken-image", `image "${label}" did not load: fix the path or remove it`);
  }

  return findings;
}
