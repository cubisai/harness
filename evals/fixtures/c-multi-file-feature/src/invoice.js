import { formatAmount } from "./format.js";

// One invoice line: "Name: 12.00".
export function invoiceLine(item) {
  return `${item.name}: ${formatAmount(item.amount)}`;
}
