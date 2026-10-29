/// <reference types="vite/client" />
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AboutInfo } from "../src/shared/types";

// The sheet imports a real asset; the static render only needs a src string.
vi.mock("../src/renderer/src/assets/cubiq-icon.png", () => ({ default: "cubiq-icon.png" }));

const fakeAbout: AboutInfo = {
  name: "CubiQ",
  version: "0.1.2",
  commit: "abc1234",
  commitDate: "2026-09-27",
  electron: "44.4.5",
  chrome: "140.0.0.0",
  node: "22.19.0",
  os: "macOS 15.0",
  changelog: [
    { hash: "abc1234", date: "2026-09-27", subject: "Add the About sheet with a git build stamp" },
    { hash: "def5678", date: "2026-09-26", subject: "Keep the composer focused after a permission prompt" },
  ],
};

describe("store apply open-about", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sets aboutOpen", async () => {
    vi.stubGlobal("window", { unskilled: { aboutInfo: vi.fn(() => Promise.resolve(fakeAbout)) } });
    const { useStore } = await import("../src/renderer/src/store");
    useStore.setState({ aboutOpen: false });
    useStore.getState().apply({ type: "open-about" });
    expect(useStore.getState().aboutOpen).toBe(true);
  });
});

describe("AboutSheet", () => {
  afterEach(() => vi.unstubAllGlobals());

  // `renderToStaticMarkup` runs no effects, so the fetch never resolves during
  // it: the resolved info arrives through the same `info` prop the app leaves
  // unset. The api is still stubbed, as the connected sheet would call it.
  // Server rendering reads zustand's initial state, so seed it directly.
  const render = async (info: AboutInfo) => {
    vi.stubGlobal("window", { unskilled: { aboutInfo: vi.fn(() => Promise.resolve(info)) } });
    const { useStore } = await import("../src/renderer/src/store");
    const { AboutSheet } = await import("../src/renderer/src/components/AboutSheet");
    const state = useStore.getInitialState();
    const saved = state.aboutOpen;
    try {
      state.aboutOpen = true;
      return renderToStaticMarkup(<AboutSheet info={info} />);
    } finally {
      state.aboutOpen = saved;
    }
  };

  it("renders the version, commit and a changelog subject", async () => {
    const html = await render(fakeAbout);
    expect(html).toContain("CubiQ");
    expect(html).toContain("Version 0.1.2");
    expect(html).toContain("abc1234");
    expect(html).toContain("2026-09-27");
    expect(html).toContain("Add the About sheet with a git build stamp");
    expect(html).toContain("Electron 44.4.5");
    expect(html).toContain("Copy info");
  });

  it("shows Development build when the commit is null", async () => {
    const html = await render({ ...fakeAbout, commit: null, commitDate: null });
    expect(html).toContain("Development build");
    expect(html).toMatch(/about-commit">Development build</);
    expect(html).not.toMatch(/about-commit">abc1234/);
  });

  it("renders nothing when closed", async () => {
    vi.stubGlobal("window", { unskilled: { aboutInfo: vi.fn(() => Promise.resolve(fakeAbout)) } });
    const { useStore } = await import("../src/renderer/src/store");
    const { AboutSheet } = await import("../src/renderer/src/components/AboutSheet");
    const state = useStore.getInitialState();
    const saved = state.aboutOpen;
    try {
      state.aboutOpen = false;
      expect(renderToStaticMarkup(<AboutSheet info={fakeAbout} />)).toBe("");
    } finally {
      state.aboutOpen = saved;
    }
  });
});
