import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/csv.js";

test("plain rows", () => assert.deepEqual(parseCsv("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]));
test("comma inside quotes", () => assert.deepEqual(parseCsv('name,note\n"Smith, J",hi\n'), [["name", "note"], ["Smith, J", "hi"]]));
test("doubled quote is a literal quote", () => assert.deepEqual(parseCsv('"say ""hi""",x'), [['say "hi"', "x"]]));
test("newline inside quotes", () => assert.deepEqual(parseCsv('"line1\nline2",z\n'), [["line1\nline2", "z"]]));
test("CRLF line endings", () => assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]));
test("empty fields", () => assert.deepEqual(parseCsv('a,,c\n"",x,\n'), [["a", "", "c"], ["", "x", ""]]));
test("no trailing newline", () => assert.deepEqual(parseCsv("a,b"), [["a", "b"]]));
