import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("production plugin startup ordering", () => {
  it("opens reviewed delivery only after recovery, managed factories, mediation and review/account wiring", () => {
    const main = readFileSync("src/main/index.ts", "utf8");
    const ready = main.indexOf("pluginDeliveryReady = true;");
    expect(main).toContain("let pluginDeliveryReady = false;");
    expect(main).toContain("deliveryReady: () => pluginDeliveryReady,");
    expect(main).toMatch(/new ExtensionService\(\{\s*bundles,/);
    for (const seam of ["bundles.recover();", "service.setManagedTools(", "service.setManagedRun(", "service.setManagedPermission(", "const managedConnectors", "const pluginConnectors", 'ipcMain.handle("apps:connector-connect"', 'ipcMain.handle("apps:call"', "const pluginTools", "const extensionService"]) {
      expect(main.indexOf(seam), seam).toBeGreaterThan(-1);
      expect(main.indexOf(seam), seam).toBeLessThan(ready);
    }
    const scheduler = main.indexOf("automations = startAutomations(");
    expect(scheduler).toBeGreaterThan(ready);
    expect(main.indexOf("pruneSkillCopies();", ready)).toBeLessThan(scheduler);
    expect(main.indexOf("await updaterBackend()", ready)).toBeGreaterThan(scheduler);
    expect(main.indexOf("pluginDeliveryReady = false;", ready)).toBeLessThan(main.indexOf("managedRules.dispose();", ready));
  });
});
