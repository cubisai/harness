import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { ModelPicker, contextChoices } from "../src/renderer/src/components/ModelPicker";
import { ModeMenu } from "../src/renderer/src/components/ThreadControls";
import type { AgentInfo } from "../src/shared/types";
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

const agents: AgentInfo[] = [
  { id: "codex", label: "Codex", models: [], defaultModel: "default", capabilities: SAFE_DEFAULTS },
  { id: "opencode", label: "OpenCode", models: opencode, defaultModel: "default", capabilities: SAFE_DEFAULTS },
];
const noop = () => {};
const picker = (over: Partial<Parameters<typeof ModelPicker>[0]> = {}) =>
  renderToStaticMarkup(
    <ModelPicker agents={agents} agent="opencode" models={opencode} current="tokenharbor/glm-5.3-flash" effort={null} onModel={noop} onAgent={noop} onEffort={noop} onContextWindow={noop} {...over} />,
  );
const luna = { id: "gpt-6-luna", label: "GPT-6-Luna", contextWindow: 272000, maxContextWindow: 872000, efforts: ["low", "high"], defaultEffort: "high" };

describe("ModelPicker", () => {
  it("shows the current model's own name, closed", () => {
    const html = picker();
    expect(html).toContain(">GLM 5.3 Flash</span>");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("model-menu");
  });

  it("shows the effective effort on the button: the pick, else the model's default", () => {
    expect(picker({ models: [luna], current: "gpt-6-luna" })).toContain('model-picker-effort">High</span>');
    expect(picker({ models: [luna], current: "gpt-6-luna", effort: "low" })).toContain('model-picker-effort">Low</span>');
    expect(picker()).not.toContain("model-picker-effort");
    expect(picker({ models: [luna], current: "gpt-6-luna", effort: "high" })).toContain('model-picker-effort">High</span>');
  });

  it("lists this agent's models, then the other agents as switch rows", () => {
    const html = picker({ defaultOpen: true });
    expect(html).toContain("Token Harbor");
    expect(html).toContain("Switch agent");
    expect(html).toContain(">Codex</span>");
    expect(html).not.toContain(">OpenCode</span><span class=\"hint\">switch");
  });

  it("puts a Thinking slider and Context inside the menu for a model that has them", () => {
    const html = picker({ defaultOpen: true, models: [luna], current: "gpt-6-luna" });
    expect(html).toContain(">Thinking<");
    // One stop per level; unset, it rests on the model's default and offers no Reset.
    expect(html).toMatch(/type="range"[^>]*min="0"[^>]*max="1"/);
    expect(html).toContain('aria-valuetext="High · default"');
    expect(html).toContain(">Faster<");
    expect(html).toContain(">Smarter<");
    expect(html).not.toContain(">Reset<");
    expect(html).toContain(">Context<");
    // Context is the same kind of slider: two stops, resting on the default window.
    expect(html).toContain('aria-label="Context window"');
    expect(html).toContain('aria-valuetext="Default 272K"');
    expect(html).toContain(">272K<");
    expect(html).toContain(">872K<");
  });

  it("shows a picked level and offers Reset back to the default", () => {
    const html = picker({ defaultOpen: true, models: [luna], current: "gpt-6-luna", effort: "low" });
    expect(html).toContain('aria-valuetext="Low"');
    expect(html).toContain('value="0"');
    expect(html).toContain(">Reset<");
  });

  it("puts the Context knob on Max when the larger window is picked", () => {
    const html = picker({ defaultOpen: true, models: [luna], current: "gpt-6-luna", contextWindow: 872000 });
    expect(html).toContain('aria-valuetext="Max 872K"');
    expect(html).toMatch(/aria-label="Context window"/);
    expect((html.match(/class="effort hot/g) ?? []).length).toBe(1);
  });

  it("lights the dots green from Xhigh up, or past High when there's no Xhigh", () => {
    const gpt = { ...luna, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" };
    const hot = (effort: string, model = gpt) => /class="effort hot/.test(picker({ defaultOpen: true, models: [model], current: model.id, effort }));
    expect(hot("high")).toBe(false);
    expect(hot("xhigh")).toBe(true);
    expect(hot("max")).toBe(true);
    const claude = { ...luna, efforts: ["low", "medium", "high", "max"] };
    expect(hot("high", claude)).toBe(false);
    expect(hot("max", claude)).toBe(true);
    expect(hot("high", { ...luna, efforts: ["low", "medium", "high"] })).toBe(false);
  });

  it("says a model without thinking levels doesn't offer them, and leaves Context out", () => {
    const html = picker({ defaultOpen: true });
    expect(html).toContain("Not offered by GLM 5.3 Flash");
    expect(html).not.toContain('aria-label="Thinking"');
    expect(html).not.toContain(">Context<");
  });
});

describe("contextChoices", () => {
  it("offers Default and Max only when the model accepts a larger window", () => {
    expect(contextChoices(luna)).toEqual([
      { label: "Default 272K", value: null },
      { label: "Max 872K", value: 872000 },
    ]);
    expect(contextChoices({ ...luna, maxContextWindow: 272000 })).toEqual([]);
    expect(contextChoices({ id: "opus", label: "Opus 5.5" })).toEqual([]);
    expect(contextChoices(undefined)).toEqual([]);
  });
});

describe("ModeMenu", () => {
  it("shows the current mode, and Full access in the danger style", () => {
    expect(renderToStaticMarkup(<ModeMenu mode="ask" onPick={noop} />)).toContain("Ask");
    const full = renderToStaticMarkup(<ModeMenu mode="full" onPick={noop} />);
    expect(full).toContain("mode-chip danger");
    expect(full).toContain("Full access");
  });
});
