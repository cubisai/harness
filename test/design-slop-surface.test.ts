import { describe, expect, it } from "vitest";
import {
  collectSurfaceSlop,
  surfaceSlopFindings,
  type SurfaceNode,
  type SurfacePaint,
  type SurfaceSlopSnapshot,
} from "../src/main/design/slop-surface";

const paint = (over: Partial<SurfacePaint> = {}): SurfacePaint => ({
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  backgroundSize: "auto",
  boxShadow: "none",
  borderWidth: { top: 0, right: 0, bottom: 0, left: 0 },
  borderColor: {
    top: "rgb(0, 0, 0)",
    right: "rgb(0, 0, 0)",
    bottom: "rgb(0, 0, 0)",
    left: "rgb(0, 0, 0)",
  },
  width: 300,
  height: 100,
  radius: 0,
  animationName: "none",
  animationIterationCount: "1",
  animationDuration: "0s",
  content: "none",
  ...over,
});

const node = (over: Partial<SurfaceNode> = {}): SurfaceNode => ({
  selector: "div",
  tag: "div",
  text: "",
  ownText: "",
  parentWidth: 600,
  paint: paint(),
  before: paint(),
  after: paint(),
  color: "rgb(0, 0, 0)",
  effectiveBackground: "rgb(255, 255, 255)",
  cardLike: false,
  leaf: false,
  container: null,
  headingText: null,
  opacity: 1,
  visibility: "visible",
  position: "static",
  hiddenContext: false,
  editableContext: false,
  ...over,
});

const snap = (over: Partial<SurfaceSlopSnapshot> = {}): SurfaceSlopSnapshot => ({
  dark: false,
  nodes: [],
  prose: "",
  paused: false,
  translateKeyframes: [],
  ...over,
});

const hits = (out: ReturnType<typeof surfaceSlopFindings>, id: string) => out.filter((f) => f.id === id);

const hairlineCard = (over: Partial<SurfacePaint> = {}): SurfacePaint =>
  paint({
    borderWidth: { top: 1, right: 1, bottom: 1, left: 1 },
    boxShadow: "rgba(0, 0, 0, 0.15) 0px 8px 30px 0px",
    ...over,
  });

describe("ghost-card", () => {
  it("flags two hairline borders with a wide soft shadow", () => {
    const out = surfaceSlopFindings(
      snap({
        nodes: [
          node({ selector: ".card-a", paint: hairlineCard() }),
          node({ selector: ".card-b", paint: hairlineCard() }),
        ],
      }),
    );
    const found = hits(out, "ghost-card");
    expect(found).toHaveLength(2);
    expect(found[0]?.selector).toBe(".card-a");
    expect(found[0]?.detail).toContain("hairline");
  });

  it("does not flag one card or a shadow with too much alpha", () => {
    expect(hits(surfaceSlopFindings(snap({ nodes: [node({ paint: hairlineCard() })] })), "ghost-card")).toEqual([]);
    const heavy = hairlineCard({ boxShadow: "rgba(0, 0, 0, 0.5) 0px 8px 30px 0px" });
    expect(
      hits(
        surfaceSlopFindings(snap({ nodes: [node({ paint: heavy }), node({ selector: ".b", paint: heavy })] })),
        "ghost-card",
      ),
    ).toEqual([]);
  });
});

describe("radial-halo", () => {
  const halo = paint({
    width: 600,
    height: 400,
    backgroundImage: "radial-gradient(circle at 50% 0%, rgba(88, 101, 242, 0.3), transparent 70%)",
  });

  it("flags a large radial glow on a dark page", () => {
    const out = surfaceSlopFindings(snap({ dark: true, nodes: [node({ selector: ".halo", paint: halo })] }));
    const found = hits(out, "radial-halo");
    expect(found).toHaveLength(1);
    expect(found[0]?.selector).toBe(".halo");
    expect(found[0]?.detail).toContain("radial");
  });

  it("does not flag a light page or a small glow", () => {
    expect(hits(surfaceSlopFindings(snap({ nodes: [node({ paint: halo })] })), "radial-halo")).toEqual([]);
    const small = paint({ ...halo, width: 320, height: 200 });
    expect(
      hits(surfaceSlopFindings(snap({ dark: true, nodes: [node({ paint: small })] })), "radial-halo"),
    ).toEqual([]);
  });
});

describe("ai-palette", () => {
  const paired = "linear-gradient(135deg, rgb(139, 92, 246), rgb(34, 211, 238))";

  it("flags a purple-to-cyan gradient", () => {
    const out = surfaceSlopFindings(snap({ nodes: [node({ selector: ".hero", paint: paint({ backgroundImage: paired }) })] }));
    const found = hits(out, "ai-palette");
    expect(found).toHaveLength(1);
    expect(found[0]?.selector).toBe(".hero");
    expect(found[0]?.detail).toContain("palette");
  });

  it("does not flag purple paired with another hue", () => {
    const warm = "linear-gradient(135deg, rgb(139, 92, 246), rgb(251, 146, 60))";
    expect(
      hits(surfaceSlopFindings(snap({ nodes: [node({ paint: paint({ backgroundImage: warm }) })] })), "ai-palette"),
    ).toEqual([]);
  });

  it("flags a page painted purple and cyan", () => {
    const purple = [0, 1, 2].map((i) =>
      node({ selector: `.p${i}`, paint: paint({ backgroundColor: "rgb(139, 92, 246)" }) }),
    );
    const cyan = [0, 1, 2].map((i) =>
      node({ selector: `.c${i}`, paint: paint({ backgroundColor: "rgb(34, 211, 238)" }) }),
    );
    const out = surfaceSlopFindings(snap({ nodes: [...purple, ...cyan] }));
    const found = hits(out, "ai-palette");
    expect(found).toHaveLength(1);
    expect(found[0]?.selector).toBe("body");
  });

  it("does not flag two purple elements and three cyan elements", () => {
    const purple = [0, 1].map((i) => node({ paint: paint({ backgroundColor: "rgb(139, 92, 246)" }) }));
    const cyan = [0, 1, 2].map((i) => node({ paint: paint({ backgroundColor: "rgb(34, 211, 238)" }) }));
    expect(hits(surfaceSlopFindings(snap({ nodes: [...purple, ...cyan] })), "ai-palette")).toEqual([]);
  });
});

describe("gray-on-color", () => {
  it("flags neutral grey text on a saturated fill", () => {
    const out = surfaceSlopFindings(
      snap({
        nodes: [
          node({
            selector: ".muted-cta",
            ownText: "Get started",
            color: "rgb(120, 120, 120)",
            effectiveBackground: "rgb(37, 99, 235)",
          }),
        ],
      }),
    );
    const found = hits(out, "gray-on-color");
    expect(found).toHaveLength(1);
    expect(found[0]?.selector).toBe(".muted-cta");
    expect(found[0]?.detail).toContain("grey");
  });

  it("does not flag grey text on a near-white surface", () => {
    expect(
      hits(
        surfaceSlopFindings(
          snap({
            nodes: [
              node({
                ownText: "Get started",
                color: "rgb(120, 120, 120)",
                effectiveBackground: "rgb(243, 244, 246)",
              }),
            ],
          }),
        ),
        "gray-on-color",
      ),
    ).toEqual([]);
  });
});

describe("repeating-stripes", () => {
  const stripes = "repeating-linear-gradient(45deg, rgb(0, 0, 0), rgb(0, 0, 0) 10px, transparent 10px, transparent 20px)";

  it("flags a repeating gradient on the pseudo layer", () => {
    const out = surfaceSlopFindings(
      snap({ nodes: [node({ selector: ".striped", before: paint({ backgroundImage: stripes }) })] }),
    );
    const found = hits(out, "repeating-stripes");
    expect(found).toHaveLength(1);
    expect(found[0]?.selector).toBe(".striped");
    expect(found[0]?.detail).toContain("stripes");
  });

  it("does not flag a plain gradient", () => {
    expect(
      hits(
        surfaceSlopFindings(snap({ nodes: [node({ paint: paint({ backgroundImage: "linear-gradient(90deg, rgb(0, 0, 0), rgb(255, 255, 255))" }) })] })),
        "repeating-stripes",
      ),
    ).toEqual([]);
  });
});

describe("grid-background", () => {
  const grid = [
    "linear-gradient(rgba(0, 0, 0, 0.06) 1px, transparent 1px)",
    "linear-gradient(90deg, rgba(0, 0, 0, 0.06) 1px, transparent 1px)",
  ].join(", ");

  it("flags the two-layer graph-paper trick", () => {
    const out = surfaceSlopFindings(
      snap({
        nodes: [
          node({
            selector: ".dotted-page",
            paint: paint({ width: 600, height: 400, backgroundImage: grid, backgroundSize: "24px 24px, 24px 24px" }),
          }),
        ],
      }),
    );
    const found = hits(out, "grid-background");
    expect(found).toHaveLength(1);
    expect(found[0]?.selector).toBe(".dotted-page");
    expect(found[0]?.detail).toContain("grid");
  });

  it("does not flag a coarse or single-layer background", () => {
    const coarse = paint({ width: 600, height: 400, backgroundImage: grid, backgroundSize: "200px 200px" });
    expect(hits(surfaceSlopFindings(snap({ nodes: [node({ paint: coarse })] })), "grid-background")).toEqual([]);
    const single = paint({
      width: 600,
      height: 400,
      backgroundImage: "linear-gradient(rgba(0, 0, 0, 0.06) 1px, transparent 1px)",
      backgroundSize: "24px 24px",
    });
    expect(hits(surfaceSlopFindings(snap({ nodes: [node({ paint: single })] })), "grid-background")).toEqual([]);
  });
});

describe("glow-border", () => {
  const glow = paint({
    borderWidth: { top: 1, right: 1, bottom: 1, left: 1 },
    borderColor: {
      top: "rgb(34, 211, 238)",
      right: "rgb(34, 211, 238)",
      bottom: "rgb(34, 211, 238)",
      left: "rgb(34, 211, 238)",
    },
    boxShadow: "rgba(34, 211, 238, 0.5) 0px 0px 12px 0px",
  });

  it("flags two glowing borders on a dark page", () => {
    const out = surfaceSlopFindings(
      snap({
        dark: true,
        nodes: [node({ selector: ".glow-a", paint: glow }), node({ selector: ".glow-b", paint: glow })],
      }),
    );
    const found = hits(out, "glow-border");
    expect(found).toHaveLength(2);
    expect(found[0]?.selector).toBe(".glow-a");
    expect(found[0]?.detail).toContain("glowing");
  });

  it("does not flag a light page or a single glowing border", () => {
    expect(
      hits(
        surfaceSlopFindings(
          snap({ nodes: [node({ paint: glow }), node({ selector: ".b", paint: glow })] }),
        ),
        "glow-border",
      ),
    ).toEqual([]);
    expect(hits(surfaceSlopFindings(snap({ dark: true, nodes: [node({ paint: glow })] })), "glow-border")).toEqual([]);
  });
});

describe("pulsing-dot", () => {
  const dot = paint({
    width: 10,
    height: 10,
    radius: 5,
    animationName: "pulse",
    animationIterationCount: "infinite",
    animationDuration: "1.5s",
  });

  it("flags a tiny round endlessly animated dot", () => {
    const out = surfaceSlopFindings(snap({ nodes: [node({ selector: ".status-dot", paint: dot })] }));
    const found = hits(out, "pulsing-dot");
    expect(found).toHaveLength(1);
    expect(found[0]?.selector).toBe(".status-dot");
    expect(found[0]?.detail).toContain("pulsing");
  });

  it("does not flag a larger dot or a square one", () => {
    expect(
      hits(surfaceSlopFindings(snap({ nodes: [node({ paint: paint({ ...dot, width: 20, height: 20, radius: 10 }) })] })), "pulsing-dot"),
    ).toEqual([]);
    expect(
      hits(surfaceSlopFindings(snap({ nodes: [node({ paint: paint({ ...dot, radius: 2 }) })] })), "pulsing-dot"),
    ).toEqual([]);
  });
});

describe("blinking-cursor", () => {
  const blink = paint({
    width: 2,
    height: 20,
    animationName: "blink",
    animationIterationCount: "infinite",
    animationDuration: "1s",
  });

  it("flags an endlessly blinking caret", () => {
    const out = surfaceSlopFindings(snap({ nodes: [node({ selector: ".fake-caret", paint: blink })] }));
    const found = hits(out, "blinking-cursor");
    expect(found).toHaveLength(1);
    expect(found[0]?.selector).toBe(".fake-caret");
    expect(found[0]?.detail).toContain("cursor");
  });

  it("does not flag a caret inside an editable control", () => {
    expect(
      hits(surfaceSlopFindings(snap({ nodes: [node({ paint: blink, editableContext: true })] })), "blinking-cursor"),
    ).toEqual([]);
  });
});

describe("marquee", () => {
  it("flags a literal marquee element", () => {
    const out = surfaceSlopFindings(snap({ nodes: [node({ selector: "marquee.ticker", tag: "marquee" })] }));
    const found = hits(out, "marquee");
    expect(found).toHaveLength(1);
    expect(found[0]?.selector).toBe("marquee.ticker");
    expect(found[0]?.detail).toContain("marquee");
  });

  it("flags a wide translating track with no pause", () => {
    const out = surfaceSlopFindings(
      snap({
        nodes: [
          node({
            selector: ".track",
            parentWidth: 600,
            paint: paint({
              width: 900,
              animationName: "slide",
              animationIterationCount: "infinite",
              animationDuration: "20s",
            }),
          }),
        ],
        translateKeyframes: ["slide"],
      }),
    );
    expect(hits(out, "marquee")[0]?.selector).toBe(".track");
  });

  it("does not flag a paused or barely wider track", () => {
    const track = node({
      parentWidth: 600,
      paint: paint({
        width: 900,
        animationName: "slide",
        animationIterationCount: "infinite",
        animationDuration: "20s",
      }),
    });
    expect(hits(surfaceSlopFindings(snap({ nodes: [track], translateKeyframes: ["slide"], paused: true })), "marquee")).toEqual([]);
    const narrow = node({
      parentWidth: 600,
      paint: paint({
        width: 700,
        animationName: "slide",
        animationIterationCount: "infinite",
        animationDuration: "20s",
      }),
    });
    expect(hits(surfaceSlopFindings(snap({ nodes: [narrow], translateKeyframes: ["slide"] })), "marquee")).toEqual([]);
  });
});

describe("hidden-at-rest", () => {
  const launch = (i: number, over: Partial<SurfaceNode> = {}) =>
    node({
      selector: `.launch-${i}`,
      text: "Your saved plans appear here",
      opacity: 0,
      ...over,
    });

  it("flags three blocks that start invisible", () => {
    const out = surfaceSlopFindings(snap({ nodes: [launch(1), launch(2), launch(3)] }));
    const found = hits(out, "hidden-at-rest");
    expect(found).toHaveLength(1);
    expect(found[0]?.selector).toBe(".launch-1");
    expect(found[0]?.detail).toContain("blocks start invisible");
    expect(found[0]?.detail).toContain("3");
  });

  it("does not flag two blocks, fixed blocks or hidden-context blocks", () => {
    expect(hits(surfaceSlopFindings(snap({ nodes: [launch(1), launch(2)] })), "hidden-at-rest")).toEqual([]);
    const mixed = [launch(1), launch(2), launch(3, { position: "fixed" }), launch(4, { hiddenContext: true })];
    expect(hits(surfaceSlopFindings(snap({ nodes: mixed })), "hidden-at-rest")).toEqual([]);
  });
});

describe("em-dash-overuse", () => {
  it("flags em dashes in most sentences", () => {
    const out = surfaceSlopFindings(
      snap({ prose: "One — two. Three — four. Five — six. Seven. Eight. Nine." }),
    );
    const found = hits(out, "em-dash-overuse");
    expect(found).toHaveLength(1);
    expect(found[0]?.selector).toBe("body");
    expect(found[0]?.detail).toContain("3 of 6 sentences");
  });

  it("does not flag a dash in a third of the sentences", () => {
    expect(
      hits(
        surfaceSlopFindings(snap({ prose: "One — two. Three — four. Five. Six. Seven. Eight." })),
        "em-dash-overuse",
      ),
    ).toEqual([]);
  });
});

describe("repeated-label", () => {
  const label = (selector: string, text: string, container: string | null, tag = "span") =>
    node({ selector, tag, text, container, leaf: true });

  it("flags the same label twice in one card", () => {
    const out = surfaceSlopFindings(
      snap({ nodes: [label(".plan-a", "Pro plan", ".card", "h3"), label(".plan-b", "pro plan", ".card")] }),
    );
    const found = hits(out, "repeated-label");
    expect(found).toHaveLength(1);
    expect(found[0]?.selector).toBe(".plan-a");
    expect(found[0]?.detail).toContain("Pro plan");
    expect(found[0]?.detail).toContain("twice");
  });

  it("does not flag different labels or labels outside a card", () => {
    expect(
      hits(
        surfaceSlopFindings(snap({ nodes: [label(".a", "Pro plan", ".card"), label(".b", "Team plan", ".card")] })),
        "repeated-label",
      ),
    ).toEqual([]);
    expect(
      hits(surfaceSlopFindings(snap({ nodes: [label(".a", "Pro plan", null), label(".b", "Pro plan", null)] })), "repeated-label"),
    ).toEqual([]);
  });

  it("does not flag same-tag repeats or clock times", () => {
    expect(
      hits(surfaceSlopFindings(snap({ nodes: [label(".a", "Edit row", ".card"), label(".b", "Edit row", ".card")] })), "repeated-label"),
    ).toEqual([]);
    expect(
      hits(
        surfaceSlopFindings(snap({ nodes: [label(".a", "9:41", ".card", "h3"), label(".b", "9:41", ".card")] })),
        "repeated-label",
      ),
    ).toEqual([]);
  });
});

describe("not-x-y", () => {
  it("quotes the Not X. Y. slogan cadence", () => {
    const out = surfaceSlopFindings(snap({ prose: "Not a tool. A teammate." }));
    const found = hits(out, "not-x-y");
    expect(found).toHaveLength(1);
    expect(found[0]?.selector).toBe("body");
    expect(found[0]?.detail).toContain('"Not a tool. A teammate."');
  });

  it("does not flag a plain negative sentence", () => {
    expect(
      hits(surfaceSlopFindings(snap({ prose: "It is not a tool, and it is not a teammate." })), "not-x-y"),
    ).toEqual([]);
  });
});

describe("theater", () => {
  it("flags theatre used as a metaphor", () => {
    const out = surfaceSlopFindings(snap({ prose: "This is security theater." }));
    const found = hits(out, "theater");
    expect(found).toHaveLength(1);
    expect(found[0]?.selector).toBe("body");
    expect(found[0]?.detail).toContain('"security theater"');
  });

  it("does not flag an actual movie theater", () => {
    expect(hits(surfaceSlopFindings(snap({ prose: "We went to the movie theater." })), "theater")).toEqual([]);
  });
});

describe("highlighter", () => {
  it("flags a painted band behind a few headline words", () => {
    const out = surfaceSlopFindings(
      snap({
        nodes: [
          node({
            selector: "h1 span.mark",
            tag: "span",
            text: "ship",
            headingText: "Ship faster today",
            paint: paint({ backgroundColor: "rgb(255, 230, 0)" }),
          }),
        ],
      }),
    );
    const found = hits(out, "highlighter");
    expect(found).toHaveLength(1);
    expect(found[0]?.selector).toBe("h1 span.mark");
    expect(found[0]?.detail).toContain("highlighter");
  });

  it("does not flag the whole heading or an unpainted span", () => {
    expect(
      hits(
        surfaceSlopFindings(
          snap({
            nodes: [
              node({
                tag: "span",
                text: "Ship faster today",
                headingText: "Ship faster today",
                paint: paint({ backgroundColor: "rgb(255, 230, 0)" }),
              }),
            ],
          }),
        ),
        "highlighter",
      ),
    ).toEqual([]);
    expect(
      hits(
        surfaceSlopFindings(snap({ nodes: [node({ tag: "span", text: "ship", headingText: "Ship faster today" })] })),
        "highlighter",
      ),
    ).toEqual([]);
  });
});

describe("serialization", () => {
  it("findings function is self-contained", () => {
    const copy = new Function(`return (${surfaceSlopFindings.toString()})`)() as typeof surfaceSlopFindings;
    const fixture = snap({ prose: "This is security theater." });
    expect(copy(fixture)).toEqual(surfaceSlopFindings(fixture));
  });

  it("collector is a serializable page function", () => {
    expect(() => new Function(`return (${collectSurfaceSlop.toString()})`)()).not.toThrow();
    expect(collectSurfaceSlop.toString()).toContain("getComputedStyle");
  });
});
