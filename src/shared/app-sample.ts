import type { AppInfo } from "./types";

export const SAMPLE_VERSION = 1;
export const SAMPLE_MODES = ["data", "empty", "offline"] as const;
export type SampleMode = (typeof SAMPLE_MODES)[number];
export const SAMPLE_PRODUCT = "Sample sketchbook";
export const SAMPLE_OFFLINE = "Sample connector is offline.";

/** Disposable connector replies and storage, scoped to one preview or checker run. */
export function appSample(mode: SampleMode, grants: AppInfo["grants"]) {
  let calls = 0;
  return {
    store: new Map<string, unknown>(),
    call(server: string, tool: string) {
      if (!grants.some((g) => g.server === server && g.tools.includes(tool))) return { ok: false as const, error: `Not granted: ${server}.${tool}` };
      if (server !== "shop" || tool !== "sales_summary") return { ok: false as const, error: `No sample reply for ${server}.${tool}` };
      calls++;
      if (mode === "offline" && calls === 1) return { ok: false as const, error: SAMPLE_OFFLINE };
      return { ok: true as const, result: { currency: "USD", days: mode === "empty" ? [] : [{ date: "2026-01-05", revenue: 24, orders: 2 }],
        topProducts: mode === "empty" ? [] : [{ name: SAMPLE_PRODUCT, revenue: 24, units: 2 }] } };
    },
  };
}
