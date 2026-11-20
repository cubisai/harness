import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../src/renderer/src/store";
import { matchCommands, selectedPluginCommand } from "../src/renderer/src/commands";
import { ProposalCardView } from "../src/renderer/src/components/ProposalCard";
import type { ExtensionProposalView } from "../src/shared/types";
import type { PluginCommandView } from "../src/shared/plugin-parts";

const command: PluginCommandView = { key: "g~notes", name: "review", revision: "one", command: "notes.review", description: "Reviewed prompt" };
const list = vi.fn<() => Promise<PluginCommandView[]>>(), send = vi.fn(async () => {});
beforeEach(() => {
  list.mockReset(); send.mockClear();
  vi.stubGlobal("window", { unskilled: { listPluginCommands: list, send } });
  useStore.setState({ pluginCommands: [], pluginCommandsError: null, pluginCommandsLoading: false });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("plugin command loading/error/Retry", () => {
  it("shows a failed catalog as unavailable, preserves built-ins, and Retry only loads/prepares", async () => {
    let reject!: (error: Error) => void;
    list.mockImplementationOnce(() => new Promise((_resolve, r) => { reject = r; }));
    const loading = useStore.getState().loadPluginCommands(); expect(useStore.getState().pluginCommandsLoading).toBe(true);
    reject(new Error("Command catalog unavailable")); await loading;
    expect(useStore.getState()).toMatchObject({ pluginCommands: [], pluginCommandsLoading: false, pluginCommandsError: "Command catalog unavailable" });
    expect(() => selectedPluginCommand("/notes.review", useStore.getState().pluginCommands)).toThrow(/unavailable/);
    expect(matchCommands("plan", useStore.getState().pluginCommands)[0]?.name).toBe("plan");
    list.mockResolvedValueOnce([command]); await useStore.getState().loadPluginCommands();
    expect(useStore.getState()).toMatchObject({ pluginCommands: [command], pluginCommandsError: null, pluginCommandsLoading: false });
    expect(matchCommands("notes", useStore.getState().pluginCommands)[0]?.plugin).toEqual({ key: command.key, name: command.name, revision: "one" });
    expect(send).not.toHaveBeenCalled();
  });
  it("a late old catalog cannot erase the newest failure or repopulate removed commands", async () => {
    let resolve!: (commands: PluginCommandView[]) => void;
    list.mockImplementationOnce(() => new Promise((r) => { resolve = r; })).mockRejectedValueOnce(new Error("Latest catalog refused"));
    const old = useStore.getState().loadPluginCommands(); await useStore.getState().loadPluginCommands();
    resolve([command]); await old;
    expect(useStore.getState()).toMatchObject({ pluginCommands: [], pluginCommandsLoading: false, pluginCommandsError: "Latest catalog refused" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("bundled app proposal failure states", () => {
  it.each([true, false])("retains reviewed scope/parts and the error; Retry available: %s", (retryable) => {
    const proposal: ExtensionProposalView = { id: "proposal", threadId: "thread", scope: { kind: "global" }, projectName: null, projectChoice: null, createdAt: 0, updatedAt: 0,
      status: "failed", error: "Owned files changed after review", retryable,
      draft: { kind: "app", name: "notes", title: "Notes", description: "Reviewed bundle", files: [], grants: [], update: true, draftKey: "d~thread~notes",
        parts: [{ kind: "command", name: "/notes.review", description: "Reviewed command", change: "changed" }, { kind: "automation", name: "brief", description: "Off/Ask", projectId: "project", projectName: "Authoring project" }] } };
    const onInstall = vi.fn();
    const html = renderToStaticMarkup(<ProposalCardView proposal={proposal} busy={null} actionError={null} previewOpen={false} onTogglePreview={() => {}} onInstall={onInstall} onReject={() => {}} />);
    expect(html).toContain('role="alert"'); expect(html).toContain("Owned files changed after review"); expect(html).toContain("Global");
    expect(html).toContain("/notes.review"); expect(html).toContain("Authoring project"); expect(html).toContain("Off/Ask");
    expect(html.includes(">Retry<")).toBe(retryable); expect(html).not.toContain("Install to"); expect(onInstall).not.toHaveBeenCalled();
  });
});
