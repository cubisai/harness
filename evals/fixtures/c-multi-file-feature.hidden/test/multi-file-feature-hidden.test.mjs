import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAmount } from "../src/format.js";
import { invoiceLine } from "../src/invoice.js";
import { report } from "../src/report.js";

test("formatAmount keeps the old output without a currency", () => {
  assert.equal(formatAmount(10), "10.00");
});

test("formatAmount prefixes the currency", () => {
  assert.equal(formatAmount(10, "USD"), "USD 10.00");
  assert.equal(formatAmount(3.5, "EUR"), "EUR 3.50");
});

test("invoiceLine threads the currency through", () => {
  assert.equal(invoiceLine({ name: "Tea", amount: 3.5 }, "EUR"), "Tea: EUR 3.50");
  assert.equal(invoiceLine({ name: "Tea", amount: 3.5 }), "Tea: 3.50");
});

test("report threads the currency through", () => {
  const items = [
    { name: "Tea", amount: 3.5 },
    { name: "Cake", amount: 2 },
  ];
  assert.equal(report(items, "USD"), "Tea: USD 3.50\nCake: USD 2.00");
  assert.equal(report(items), "Tea: 3.50\nCake: 2.00");
});
