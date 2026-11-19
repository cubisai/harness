import { describe, expect, it } from "vitest";
import { checkFolder, isPrivacyDenied, privacyMessage, privacyPaneFor } from "../src/main/mac-privacy";

const home = "/Users/me";

describe("mac privacy", () => {
  it("points home folders, iCloud and volumes at Files and Folders, the rest at Full Disk Access", () => {
    for (const p of ["/Users/me/Desktop/app", "/Users/me/Documents", "/Users/me/Downloads/x", "/Volumes/USB/x", "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/p"]) {
      expect(privacyPaneFor(p, home).paneName, p).toBe("Files and Folders");
    }
    expect(privacyPaneFor("/Users/me/Library/Mail/x", home).paneName).toBe("Full Disk Access");
    expect(privacyPaneFor("/Users/me/DocumentsOld", home).paneName).toBe("Full Disk Access");
  });

  it("only EPERM counts as a privacy refusal", () => {
    expect(isPrivacyDenied(Object.assign(new Error("x"), { code: "EPERM" }))).toBe(true);
    expect(isPrivacyDenied(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(false);
    expect(isPrivacyDenied(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(false);
  });

  it.runIf(process.platform === "darwin")("reports a refused folder, not a readable or missing one", () => {
    const refuse = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(checkFolder("/Users/me/Desktop/p", home, refuse("EPERM"))).toMatchObject({ path: "/Users/me/Desktop/p", paneName: "Files and Folders" });
    expect(checkFolder("/Users/me/Desktop/p", home, refuse("ENOENT"))).toBeNull();
    expect(checkFolder("/Users/me/Desktop/p", home, () => [])).toBeNull();
  });

  it("names the folders and the pane", () => {
    const m = privacyMessage([{ path: "/Users/me/Desktop/shop", pane: "x", paneName: "Files and Folders" }]);
    expect(m.message).toBe("CubiQ can't open “shop”");
    expect(m.detail).toContain("Privacy & Security → Files and Folders");
  });
});
