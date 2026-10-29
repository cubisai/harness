import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.js";

test("lowercase and dashes", () => assert.equal(slugify("Hello World"), "hello-world"));
test("accents", () => assert.equal(slugify("Café déjà vu"), "cafe-deja-vu"));
test("runs of other characters collapse, no edge dashes", () => assert.equal(slugify("  --Rock & Roll!!  "), "rock-roll"));
test("symbols", () => assert.equal(slugify("C++ / C# tips"), "c-c-tips"));
test("empty becomes untitled", () => {
  assert.equal(slugify("!!!"), "untitled");
  assert.equal(slugify(""), "untitled");
});
test("long slugs keep whole words", () => assert.equal(slugify("the quick brown fox jumps over the lazy dog again"), "the-quick-brown-fox-jumps-over-the-lazy"));
test("a word ending exactly at 40 is kept", () => assert.equal(slugify("abcdefghij abcdefghij abcdefghij abcdefg more"), "abcdefghij-abcdefghij-abcdefghij-abcdefg"));
test("no dash in reach: hard cut at 40", () => assert.equal(slugify("a".repeat(50)), "a".repeat(40)));
test("exactly 40 is untouched", () => assert.equal(slugify("abcdefghij-abcdefghij-abcdefghij-abcdefg"), "abcdefghij-abcdefghij-abcdefghij-abcdefg"));
