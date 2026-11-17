import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseFontFaces, systemFontFaces } from "../src/main/design/font-faces";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("kit fonts for System mode", () => {
  it("reads every kit's @font-face rules from fonts/, with their ranges", () => {
    const mui = parseFontFaces(readFileSync("design-kits/kits/mui/ui.css", "utf8"));
    expect(mui.map((f) => [f.family, f.file, f.weight])).toEqual([
      ["Roboto", "Roboto-Latin.woff2", "100 900"],
      ["Roboto", "Roboto-LatinExt.woff2", "100 900"],
    ]);
    expect(mui[0]!.unicodeRange).toMatch(/^U\+0000-00FF/);
    expect(parseFontFaces(readFileSync("design-kits/kits/shadcn-ui/ui.css", "utf8")).map((f) => f.family)).toEqual(["Geist", "Geist Mono"]);
    expect(parseFontFaces(readFileSync("design-kits/kits/chakra-ui/ui.css", "utf8")).map((f) => f.family)).toEqual(["Inter Variable"]);
    expect(parseFontFaces(readFileSync("design-kits/kits/mantine/ui.css", "utf8"))).toEqual([]);
  });
  it("skips faces that load from elsewhere, and commented-out ones", () => {
    const css = `/* @font-face { font-family: Old; src: url("fonts/old.woff2"); } */
@font-face { font-family: Web; src: url("https://example.com/web.woff2") format("woff2"); }
@font-face { font-family: 'Local'; src: local("Local"); }
@font-face { font-family: "Ok Face"; src: url(./fonts/ok.woff2) format("woff2"); font-style: italic; }`;
    expect(parseFontFaces(css)).toEqual([{ family: "Ok Face", file: "ok.woff2", style: "italic" }]);
  });
  it("hands back the bytes of each face the system folder has, once", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubiq-fonts-"));
    dirs.push(dir);
    mkdirSync(join(dir, "fonts"));
    writeFileSync(join(dir, "fonts", "a.woff2"), "AAAA");
    writeFileSync(join(dir, "ui.css"), `@font-face { font-family: A; src: url("fonts/a.woff2"); font-weight: 400; }\n@font-face { font-family: Gone; src: url("fonts/gone.woff2"); }`);
    writeFileSync(join(dir, "tokens.css"), `@font-face { font-family: A; src: url("fonts/a.woff2"); font-weight: 400; }`);
    const faces = systemFontFaces(dir);
    expect(faces.map((f) => [f.family, f.file, f.weight, Buffer.from(f.data).toString()])).toEqual([["A", "a.woff2", "400", "AAAA"]]);
    expect(systemFontFaces(join(dir, "nope"))).toEqual([]);
  });
});
