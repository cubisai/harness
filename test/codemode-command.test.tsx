import { afterEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../src/renderer/src/store";
import type { SettingsView } from "../src/shared/types";

describe("/codemode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useStore.setState(useStore.getInitialState(), true);
  });

  const stub = () => {
    const updateSettings = vi.fn(async (patch: Partial<SettingsView>) => ({ ...useStore.getState().settings, ...patch }) as SettingsView);
    vi.stubGlobal("window", { unskilled: { updateSettings } });
    return updateSettings;
  };

  it("flips code mode with no argument, starting from on (the default), and says what new threads get", async () => {
    const updateSettings = stub();
    useStore.setState({ settings: { codeMode: "on" } as SettingsView });
    await useStore.getState().setCodeMode();
    expect(updateSettings).toHaveBeenLastCalledWith({ codeMode: "off" });
    expect(useStore.getState().settings?.codeMode).toBe("off");
    expect(useStore.getState().notice).toBe("Code mode off for new threads");
    await useStore.getState().setCodeMode();
    expect(useStore.getState().settings?.codeMode).toBe("on");
    expect(useStore.getState().notice).toBe("Code mode on: new threads get run_code");
  });

  it("sets the mode it's given", async () => {
    const updateSettings = stub();
    useStore.setState({ settings: { codeMode: "on" } as SettingsView });
    await useStore.getState().setCodeMode("on");
    expect(updateSettings).toHaveBeenLastCalledWith({ codeMode: "on" });
    expect(useStore.getState().settings?.codeMode).toBe("on");
  });
});
