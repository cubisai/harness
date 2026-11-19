// A stdio MCP server with fake shop data, for Creator app tests and live journeys: a read-only sales summary,
// a read-only order list, and one tool that changes data (no readOnlyHint), so an app has to ask before it.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "shop", version: "1.0.0" });
const DAY = 86_400_000;
const today = Date.UTC(2026, 10, 18);
const products = ["Cold brew 1L", "House blend 250g", "Oat latte", "Ceramic cup", "Pour-over kit"];
const day = (i) => {
  const orders = 18 + ((i * 7) % 13) + (i % 7 === 5 ? 9 : 0);
  return { date: new Date(today - i * DAY).toISOString().slice(0, 10), orders, revenue: orders * (41 + ((i * 11) % 17)) };
};
const refunded = new Set();

server.registerTool(
  "sales_summary",
  {
    description: "Revenue and orders per day for the last N days, the previous period's totals, and top products.",
    inputSchema: { days: z.number().int().min(1).max(365).default(7) },
    annotations: { readOnlyHint: true },
  },
  async ({ days }) => {
    const rows = Array.from({ length: days }, (_, i) => day(days - 1 - i));
    const prev = Array.from({ length: days }, (_, i) => day(days + i));
    const sum = (r, k) => r.reduce((t, x) => t + x[k], 0);
    const revenue = sum(rows, "revenue");
    const orders = sum(rows, "orders");
    const data = {
      currency: "USD",
      days: rows,
      previous: { revenue: sum(prev, "revenue"), orders: sum(prev, "orders") },
      topProducts: products.map((name, i) => ({ name, units: Math.round(orders * [0.31, 0.22, 0.4, 0.05, 0.02][i]), revenue: Math.round(revenue * [0.27, 0.24, 0.19, 0.08, 0.05][i]) })),
    };
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
  },
);

server.registerTool(
  "list_orders",
  { description: "Recent orders, newest first.", inputSchema: { limit: z.number().int().min(1).max(100).default(20) }, annotations: { readOnlyHint: true } },
  async ({ limit }) => {
    const orders = Array.from({ length: limit }, (_, i) => ({ id: 5000 - i, total: 20 + ((i * 13) % 70), refunded: refunded.has(5000 - i) }));
    return { content: [{ type: "text", text: JSON.stringify({ orders }) }], structuredContent: { orders } };
  },
);

server.registerTool("refund_order", { description: "Refund one order.", inputSchema: { id: z.number().int() } }, async ({ id }) => {
  refunded.add(id);
  return { content: [{ type: "text", text: JSON.stringify({ id, refunded: true }) }], structuredContent: { id, refunded: true } };
});

await server.connect(new StdioServerTransport());
