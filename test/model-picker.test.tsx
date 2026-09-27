import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EffortPicker } from "../src/renderer/src/components/EffortPicker";
import { ModelPicker } from "../src/renderer/src/components/ModelPicker";
import { filterModels } from "../src/renderer/src/models";

const opencode = [
  { id: "default", label: "Agent default" },
  { id: "opencode/big-pickle", label: "OpenCode Zen/Big Pickle" },
  { id: "tokenharbor/qwen3.8-flash:free", label: "Token Harbor/Qwen3.8 Flash (free)" },
  { id: "tokenharbor/glm-5.3-flash", label: "Token Harbor/GLM 5.3 Flash" },
];

describe("filterModels", () => {
  it("groups by provider, keeping the order", () => {
    expect(filterModels(opencode, "").map((g) => [g.group, g.models.map((m) => m.label)])).toEqual([
      ["", ["Agent default"]],
      ["OpenCode Zen", ["Big Pickle"]],
      ["Token Harbor", ["Qwen3.8 Flash (free)", "GLM 5.3 Flash"]],
    ]);
  });

  it("matches every word against label, id and provider", () => {
    expect(filterModels(opencode, "harbor glm").flatMap((g) => g.models.map((m) => m.id))).toEqual(["tokenharbor/glm-5.3-flash"]);
    expect(filterModels(opencode, "free").flatMap((g) => g.models.map((m) => m.id))).toEqual(["tokenharbor/qwen3.8-flash:free"]);
    expect(filterModels(opencode, "nothing-like-this")).toEqual([]);
  });

  it("groups plain Claude models under no provider", () => {
    expect(filterModels([{ id: "opus", label: "Opus 5.5" }], "")).toEqual([{ group: "", models: [{ id: "opus", label: "Opus 5.5" }] }]);
  });
});

describe("ModelPicker", () => {
  it("shows the current model's own name, closed", () => {
    const html = renderToStaticMarkup(<ModelPicker models={opencode} current="tokenharbor/glm-5.3-flash" onPick={() => {}} />);
    expect(html).toContain(">GLM 5.3 Flash</button>");
    expect(html).toContain('aria-expanded="false"');
  });
});

describe("EffortPicker", () => {
  it("renders nothing when the model offers no efforts", () => {
    expect(renderToStaticMarkup(<EffortPicker options={[]} current={null} onPick={() => {}} />)).toBe("");
  });

  it("lists Default first, then the levels, noting the model's default", () => {
    const html = renderToStaticMarkup(<EffortPicker options={["low", "high"]} current={null} defaultEffort="high" onPick={() => {}} />);
    expect(html).toContain(">Default");
    expect(html).toContain("(high)");
    expect(html).toContain(">low</button>");
    expect(html).toContain(">high</button>");
  });
});
