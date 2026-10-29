import { invoiceLine } from "./invoice.js";

// Renders every item as one invoice line per row.
export function report(items) {
  return items.map(invoiceLine).join("\n");
}
