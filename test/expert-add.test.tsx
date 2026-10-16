/// <reference types="vite/client" />
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExpertDef } from "../src/shared/experts";

/** A def with the boring fields defaulted, so each test states only what it checks. */
const def = (partial: Partial<ExpertDef> & Pick<ExpertDef, "id" | "name">): ExpertDef => ({
  kind: "agent",
  profession: "",
  persona: "",
  category: "General",
  avatarText: partial.name.slice(0, 2).toUpperCase(),
  description: "",
  tags: [],
  quickPrompts: [],
  prompt: "You are helpful.",
  skills: [],
  source: "builtin",
  version: "1.0.0",
  ...partial,
});

const importedNone = def({ id: "imported-none", name: "No-License Expert", source: "imported", license: "none", sourceUrl: "/tmp/experts/none" });
const importedMit = def({ id: "imported-mit", name: "MIT Expert", source: "imported", license: "MIT", author: "Ada Lovelace", sourceUrl: "https://github.com/owner/repo" });
const builtin = def({ id: "builtin", name: "Built In" });

/** Stub the bridge, then import the components (about.test.tsx's pattern). */
const load = async () => {
  vi.stubGlobal("window", {
    unskilled: {
      importExperts: vi.fn(async () => ({ installed: [], candidates: [], skipped: [] })),
      removeExpert: vi.fn(async () => {}),
      pickExpertSource: vi.fn(async () => null),
    },
  });
  const detail = await import("../src/renderer/src/components/experts/ExpertDetail");
  const add = await import("../src/renderer/src/components/experts/AddExpertDialog");
  return { ...detail, ...add };
};

/** React SSR separates adjacent text nodes with a comment; drop them before matching prose. */
const strip = (html: string): string => html.replace(/<!-- -->/g, "");

const detailProps = { used: 0, canSummon: false, onClose: () => {}, onSummon: () => {}, onSummonPrompt: () => {} };

describe("imported expert source", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("warns and offers Remove for an imported expert with no license", async () => {
    const { ExpertDetailContent } = await load();
    const html = strip(renderToStaticMarkup(<ExpertDetailContent {...detailProps} def={importedNone} onRemove={async () => {}} />));
    expect(html).toContain("No license: for your own use");
    expect(html).toContain("Remove");
  });

  it("shows the author and the license, and no warning, for a licensed expert", async () => {
    const { ExpertDetailContent } = await load();
    const html = strip(
      renderToStaticMarkup(<ExpertDetailContent {...detailProps} def={importedMit} onRemove={async () => {}} onUpdate={async () => {}} />),
    );
    expect(html).toContain("License: MIT");
    expect(html).toContain("Author: Ada Lovelace");
    expect(html).not.toContain("No license");
  });

  it("shows no source, remove or update for a built-in expert", async () => {
    const { ExpertDetailContent } = await load();
    const html = strip(renderToStaticMarkup(<ExpertDetailContent {...detailProps} def={builtin} />));
    expect(html).not.toContain("Source");
    expect(html).not.toContain("Remove");
    expect(html).not.toContain("Update");
  });
});

describe("AddExpertDialog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders the GitHub link input and the folder and zip buttons", async () => {
    const { AddExpertDialog } = await load();
    const html = strip(renderToStaticMarkup(<AddExpertDialog onClose={() => {}} onInstalled={() => {}} />));
    expect(html).toContain("GitHub link");
    expect(html).toContain("Folder…");
    expect(html).toContain(".zip file…");
  });
});

describe("ipcError", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("strips the IPC wrapper from a thrown error", async () => {
    const { ipcError } = await load();
    expect(ipcError(new Error("Error invoking remote method 'experts:import': Error: Package is too large."))).toBe("Package is too large.");
  });
});
