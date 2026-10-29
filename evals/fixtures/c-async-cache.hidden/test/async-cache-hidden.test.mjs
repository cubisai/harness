import { test } from "node:test";
import assert from "node:assert/strict";
import { createCache } from "../src/cache.js";

test("concurrent gets share one in-flight fetch", async () => {
  let calls = 0;
  const cache = createCache(async (key) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return `v:${key}`;
  });
  const [a, b, c] = await Promise.all([cache.get("x"), cache.get("x"), cache.get("x")]);
  assert.equal(a, "v:x");
  assert.equal(b, "v:x");
  assert.equal(c, "v:x");
  assert.equal(calls, 1, "the value was fetched more than once");
  assert.equal(cache.fetchCount(), 1);
});

test("sequential gets are still cached", async () => {
  let calls = 0;
  const cache = createCache(async (key) => {
    calls++;
    return `v:${key}`;
  });
  assert.equal(await cache.get("y"), "v:y");
  assert.equal(await cache.get("y"), "v:y");
  assert.equal(calls, 1);
});

test("different keys are fetched separately", async () => {
  const cache = createCache(async (key) => `v:${key}`);
  assert.equal(await cache.get("a"), "v:a");
  assert.equal(await cache.get("b"), "v:b");
  assert.equal(cache.fetchCount(), 2);
});
