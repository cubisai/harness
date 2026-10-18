import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/lib/slugify.js";

test("lowercases and hyphenates", () => assert.equal(slugify("Hello World"), "hello-world"));
test("collapses non-alphanumeric runs and trims dashes", () => assert.equal(slugify("  Foo -- Bar!!  "), "foo-bar"));
test("empty input", () => assert.equal(slugify(""), ""));
