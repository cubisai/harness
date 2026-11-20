import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PluginChatCardView } from "../src/renderer/src/components/PluginChatCard";
import { restorePluginFocus } from "../src/renderer/src/components/PluginHost";
import { segmentEvents } from "../src/renderer/src/turns";
import type { AppInfo, StoredEvent } from "../src/shared/types";

const card = { threadId: "t1", data: { title: "<script>never run me</script>" } };
const app: AppInfo = { key: "g~notes", name: "notes", scope: "global", title: "Notes", description: "", path: "", url: "cubiq-app://a/g~notes/card.html", grants: [], height: 120 };
const render = (state: { app: AppInfo | null; loading: boolean; error: string | null }) => renderToStaticMarkup(<PluginChatCardView {...state} card={card} onRetry={() => {}} />);

describe("plugin chat cards", () => {
  it.each(["trigger", "removed", "body"])("returns focus safely when the modal's previous focus is %s", (kind) => {
    const original = { isConnected: kind !== "removed", focus: vi.fn() };
    const composer = { focus: vi.fn() };
    const doc = { body: kind === "body" ? original : {}, querySelector: vi.fn(() => composer) };
    restorePluginFocus(original as unknown as HTMLElement, doc as unknown as Document);
    expect(original.focus).toHaveBeenCalledTimes(kind === "trigger" ? 1 : 0);
    expect(composer.focus).toHaveBeenCalledTimes(kind === "trigger" ? 0 : 1);
  });

  it("shows loading without a misleading retry or blank frame", () => {
    const html = render({ app: null, loading: true, error: null });
    expect(html).toContain("Loading plugin result…");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<button");
  });

  it.each(["This plugin card is unavailable. It may be Off or uninstalled.", "Couldn't load this plugin card."])("keeps unavailable/error states visible and retryable: %s", (error) => {
    const html = render({ app: null, loading: false, error });
    expect(html).toContain('role="status"');
    expect(html).toContain("Retry");
    expect(html).not.toContain("<iframe");
  });

  it("uses only the resolved local frame and keeps result data out of markup", () => {
    const html = render({ app, loading: false, error: null });
    expect(html).toContain('aria-label="Notes result"');
    expect(html).toContain('aria-label="Reload Notes card"');
    expect(html).toContain('src="cubiq-app://a/g~notes/card.html"');
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).not.toContain("never run me");
    expect(html).not.toContain("<script");
  });

  it("keeps persisted cards outside the collapsed work disclosure", () => {
    const stored = (seq: number, event: StoredEvent["event"]): StoredEvent => ({ seq, createdAt: seq, event });
    const events = [stored(1, { kind: "tool-use", toolUseId: "call", name: "plugin_notes__save", summary: "Paper" }), stored(2, { kind: "plugin-card", key: app.key, card: "saved", data: card.data }), stored(3, { kind: "tool-result", toolUseId: "call", isError: false, summary: "Saved" })];
    const segments = segmentEvents(events, false);
    expect(segments.map((s) => s.kind)).toEqual(["work", "event"]);
    expect(segments[1]).toEqual({ kind: "event", stored: events[1] });
  });
});
