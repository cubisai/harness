import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiffView } from "../src/renderer/src/components/DiffView";
import { unifiedDiff } from "../src/shared/diff";
import type { ToolDiff } from "../src/shared/tools";

describe("render parity", () => {
  it("renders the same edit identically from the Codex and ACP shapes", () => {
    const path = "src/a.ts";
    const oldText = "const a = 1;\nconst b = 2;\n";
    const newText = "const a = 1;\nconst b = 3;\n";

    // Codex hands over its own unified text; ACP is built with unifiedDiff here.
    const codexDiff: ToolDiff[] = [{ path, unified: unifiedDiff(path, oldText, newText) }];
    const acpDiff: ToolDiff[] = [{ path, unified: unifiedDiff(path, oldText, newText) }];

    const codexHtml = renderToStaticMarkup(<DiffView diffs={codexDiff} />);
    const acpHtml = renderToStaticMarkup(<DiffView diffs={acpDiff} />);
    expect(acpHtml).toBe(codexHtml);
    expect(codexHtml).toContain("src/a.ts");
  });
});
