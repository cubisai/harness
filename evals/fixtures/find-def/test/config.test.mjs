import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config/load.js";

test("port", () => assert.equal(parseConfig({ PORT: "1" }).port, 1));
