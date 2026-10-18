import { test } from "node:test";
import assert from "node:assert/strict";
import { greet } from "../src/greet.js";
import { welcome } from "../src/a.js";
import { banner } from "../src/b.js";
import { email } from "../src/c.js";

test("greet uses options.punctuation", () => {
  assert.equal(greet("Ada", { punctuation: "?" }), "Hello, Ada?");
  assert.equal(greet("Ada", { punctuation: "!" }), "Hello, Ada!");
});

test("options is required", () => {
  assert.throws(() => greet("Ada"));
});

test("welcome still greets", () => {
  assert.equal(welcome("Ada"), "Hello, Ada!");
});

test("banner still shouts", () => {
  assert.equal(banner("Ada"), "HELLO, ADA!");
});

test("email still embeds the greeting", () => {
  assert.equal(email("Ada"), "Hello, Ada! Welcome aboard.");
});
