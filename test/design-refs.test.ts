import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_REF_BYTES, imageKind, saveRef } from "../src/main/design/refs";
import { tempDir } from "./helpers";

const bytes = (...n: number[]): Uint8Array => new Uint8Array(n);
const ascii = (s: string): Uint8Array => bytes(...[...s].map((c) => c.charCodeAt(0)));

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPG = bytes(0xff, 0xd8, 0xff, 0xe0);
const GIF = ascii("GIF89a");
const WEBP = (() => {
  const b = new Uint8Array(12);
  b.set(ascii("RIFF"), 0);
  b.set(ascii("WEBP"), 8);
  return b;
})();

describe("imageKind", () => {
  it("detects png, jpg, webp and gif from their magic bytes", () => {
    expect(imageKind(PNG)).toBe("png");
    expect(imageKind(JPG)).toBe("jpg");
    expect(imageKind(WEBP)).toBe("webp");
    expect(imageKind(GIF)).toBe("gif");
    expect(imageKind(ascii("GIF87a"))).toBe("gif");
  });

  it("returns null for a too-short array", () => {
    expect(imageKind(bytes(0x89, 0x50, 0x4e))).toBeNull();
    expect(imageKind(new Uint8Array(0))).toBeNull();
  });

  it("returns null for random bytes", () => {
    expect(imageKind(bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12))).toBeNull();
    expect(imageKind(ascii("just some text"))).toBeNull();
  });
});

describe("saveRef", () => {
  it("saves the first ref as refs/ref-1.png holding the bytes", () => {
    const root = tempDir();
    expect(saveRef(root, PNG)).toBe("refs/ref-1.png");
    expect(readFileSync(join(root, "refs", "ref-1.png"))).toEqual(Buffer.from(PNG));
  });

  it("numbers a second ref after the first", () => {
    const root = tempDir();
    saveRef(root, PNG);
    expect(saveRef(root, WEBP)).toBe("refs/ref-2.webp");
  });

  it("continues after ref-7.jpg and ignores other names", () => {
    const root = tempDir();
    mkdirSync(join(root, "refs"), { recursive: true });
    writeFileSync(join(root, "refs", "ref-7.jpg"), "");
    writeFileSync(join(root, "refs", "notes.txt"), "");
    writeFileSync(join(root, "refs", "ref-x.png"), "");
    expect(saveRef(root, PNG)).toBe("refs/ref-8.png");
  });

  it("throws for text bytes", () => {
    const root = tempDir();
    expect(() => saveRef(root, ascii("hello"))).toThrow("Not an image (png, jpg, webp or gif).");
  });

  it("throws for an array over 10 MB", () => {
    const root = tempDir();
    expect(() => saveRef(root, new Uint8Array(MAX_REF_BYTES + 1))).toThrow("Image is over 10 MB.");
  });
});
