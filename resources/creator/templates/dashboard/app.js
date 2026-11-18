// Sales dashboard template. Only load() knows the connector: change its server, tool and mapping to fit the
// real data, keep the returned shape, and the rest of the page works unchanged.
const SERVER = "shop";
const TOOL = "sales_summary";

/** -> { currency, days: [{ date, revenue, orders }], previous: { revenue, orders } | null, top: [{ name, units, revenue }] } */
async function load(days) {
  const r = await cubiq.call(SERVER, TOOL, { days });
  return {
    currency: r.currency || "USD",
    days: (r.days || []).map((d) => ({ date: String(d.date), revenue: Number(d.revenue) || 0, orders: Number(d.orders) || 0 })),
    previous: r.previous ? { revenue: Number(r.previous.revenue) || 0, orders: Number(r.previous.orders) || 0 } : null,
    top: (r.topProducts || r.top || []).slice(0, 8).map((p) => ({ name: String(p.name), units: Number(p.units) || 0, revenue: Number(p.revenue) || 0 })),
  };
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let money = (n) => String(n);
const count = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function delta(now, before) {
  if (!before) return "";
  const pct = ((now - before) / before) * 100;
  const cls = pct > 0.5 ? "up" : pct < -0.5 ? "down" : "";
  return `<div class="delta ${cls}">${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% vs previous</div>`;
}

function render(d) {
  money = (n) => new Intl.NumberFormat(undefined, { style: "currency", currency: d.currency, maximumFractionDigits: 0 }).format(n);
  if (!d.days.length) {
    $("main").innerHTML = '<div class="note">No sales in this period.</div>';
    return;
  }
  const revenue = d.days.reduce((s, x) => s + x.revenue, 0);
  const orders = d.days.reduce((s, x) => s + x.orders, 0);
  const avg = orders ? revenue / orders : 0;
  const prevAvg = d.previous && d.previous.orders ? d.previous.revenue / d.previous.orders : 0;
  const max = Math.max(...d.days.map((x) => x.revenue), 1);
  const w = 100 / d.days.length;
  const bars = d.days
    .map((x, i) => {
      const h = (x.revenue / max) * 136;
      return `<rect x="${(i * w + w * 0.12).toFixed(3)}%" y="${(140 - h).toFixed(1)}" width="${(w * 0.76).toFixed(3)}%" height="${h.toFixed(1)}"><title>${esc(x.date)}: ${esc(money(x.revenue))}, ${count.format(x.orders)} orders</title></rect>`;
    })
    .join("");
  $("main").innerHTML = `
    <section class="stats">
      <div class="stat"><div class="label">Revenue</div><div class="value">${esc(money(revenue))}</div>${delta(revenue, d.previous && d.previous.revenue)}</div>
      <div class="stat"><div class="label">Orders</div><div class="value">${count.format(orders)}</div>${delta(orders, d.previous && d.previous.orders)}</div>
      <div class="stat"><div class="label">Average order</div><div class="value">${esc(money(avg))}</div>${delta(avg, prevAvg)}</div>
    </section>
    <h2>Revenue by day</h2>
    <div class="chart"><svg viewBox="0 0 100 140" preserveAspectRatio="none" role="img" aria-label="Revenue by day">${bars}</svg>
      <div class="axis"><span>${esc(d.days[0].date)}</span><span>${esc(d.days[d.days.length - 1].date)}</span></div></div>
    ${d.top.length ? `<h2>Top products</h2><table><thead><tr><th>Product</th><th class="num">Units</th><th class="num">Revenue</th></tr></thead><tbody>${d.top
      .map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${count.format(p.units)}</td><td class="num">${esc(money(p.revenue))}</td></tr>`)
      .join("")}</tbody></table>` : ""}`;
}

async function refresh() {
  const days = Number($("range").value);
  try {
    render(await load(days));
  } catch (err) {
    $("main").innerHTML = `<div class="note error">${esc(err.message)}<button class="retry" type="button">Retry</button></div>`;
    $("main").querySelector(".retry").onclick = refresh;
  }
}

$("range").addEventListener("change", () => {
  cubiq.store.set("days", Number($("range").value));
  refresh();
});
cubiq.store.get("days").then((d) => {
  if ([7, 30, 90].includes(d)) $("range").value = String(d);
  refresh();
});
