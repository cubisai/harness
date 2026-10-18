import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";

test("the default port changed to 8080", () => assert.equal(config.port, 8080));
