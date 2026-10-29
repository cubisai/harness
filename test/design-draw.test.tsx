import { describe, expect, it } from "vitest";
import { deviceFor, frameLayout } from "../src/renderer/src/design/frame";

describe("deviceFor", () => {
  it("maps a sized viewport to its device and leaves Fit and Slide without one", () => {
    expect(deviceFor("mobile")).toBe("phone");
    expect(deviceFor("tablet")).toBe("tablet");
    expect(deviceFor("desktop")).toBe("browser");
    expect(deviceFor("fit")).toBeNull();
    expect(deviceFor("slide")).toBeNull();
  });
});

describe("frameLayout with a device frame", () => {
  it("fits the whole frame when asked, and keeps width-fit otherwise", () => {
    const stage = { width: 531, height: 706 };
    expect(frameLayout("mobile", "fit", stage).scale).toBe(1);
    expect(frameLayout("mobile", "fit", stage, true).scale).toBeCloseTo((706 - 48) / 844, 5);
    expect(frameLayout("mobile", 0.5, stage, true).scale).toBe(0.5);
  });
});
