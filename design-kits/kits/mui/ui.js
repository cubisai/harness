/* MUI kit behaviour: ripple, tabs, dialogs, select, autocomplete, sliders, rating, number field, toggles, tree view,
 * calendar, sortable grid, transfer list, snackbar timeout. Safe on any page. */
(function () {
  "use strict";
  var d = document;
  var all = function (root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); };
  var near = function (el, sel) { return el.closest ? el.closest(sel) : null; };
  var hide = function (p) { if (p && p.matches(":popover-open")) p.hidePopover(); };

  /* Ripple: played on the host's ::after, so the markup never changes. */
  var HOSTS = '[data-ui="button"],[data-ui="icon-button"],[data-ui="fab"],[data-ui="toggle-button"],button[data-ui="chip"],[data-ui="tabs"] [role="tab"],[data-ui="menu"] [data-part="item"],[data-ui="select"] [data-part="item"],[data-ui="list"] [data-part="button"],[data-ui="accordion"] [data-part="summary"],[data-ui="pagination"] [data-part="item"],[data-ui="bottom-navigation"] [data-part="action"],[data-ui="date-calendar"] [data-part="day"]';
  var calm = window.matchMedia("(prefers-reduced-motion: reduce)");
  function ripple(e) {
    var host = near(e.target, HOSTS);
    if (!host || !host.animate || calm.matches || host.disabled) return;
    var r = host.getBoundingClientRect();
    var round = host.matches('[data-ui="icon-button"],[data-ui="date-calendar"] [data-part="day"]');
    var x = round ? r.width / 2 : e.clientX - r.left, y = round ? r.height / 2 : e.clientY - r.top;
    var size = round ? Math.max(r.width, r.height) : 2 * Math.hypot(Math.max(x, r.width - x), Math.max(y, r.height - y));
    var at = { left: x - size / 2 + "px", top: y - size / 2 + "px", width: size + "px", height: size + "px" };
    host.animate([Object.assign({ opacity: 0.3, transform: "scale(0.1)" }, at), Object.assign({ opacity: 0, transform: "scale(1)" }, at)], { duration: 550, easing: "cubic-bezier(0.4, 0, 0.2, 1)", pseudoElement: "::after" });
  }

  /* Tabs: the bar that slides sits in the list, and is added once there's something to measure. */
  function placeBar(list) {
    var on = list.querySelector('[role="tab"][aria-selected="true"]');
    if (!on) return;
    var bar = list.querySelector('[data-part="indicator"]');
    if (!bar) { bar = d.createElement("span"); bar.setAttribute("data-part", "indicator"); list.appendChild(bar); list.setAttribute("data-slides", "true"); }
    var tall = near(list, '[data-orientation="vertical"]');
    bar.style.left = tall ? "" : on.offsetLeft + "px";
    bar.style.width = tall ? "" : on.offsetWidth + "px";
    bar.style.top = tall ? on.offsetTop + "px" : "";
    bar.style.height = tall ? on.offsetHeight + "px" : "";
  }
  function pick(tab, focus) {
    var box = near(tab, '[data-ui="tabs"]');
    if (!box) return;
    all(box, '[role="tab"]').forEach(function (t) {
      var on = t === tab;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.setAttribute("tabindex", on ? "0" : "-1");
      var panel = d.getElementById(t.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    });
    placeBar(tab.parentElement);
    if (focus) tab.focus();
  }

  /* Calendar: drawn from data-month and data-selected. */
  var MONTHS = "January February March April May June July August September October November December".split(" ");
  var pad = function (n) { return ("0" + n).slice(-2); };
  function drawCalendar(c) {
    var now = new Date();
    var ym = (c.dataset.month || now.getFullYear() + "-" + pad(now.getMonth() + 1)).split("-");
    var y = +ym[0], m = +ym[1] - 1;
    var first = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate();
    var today = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
    var icon = function (name) { return '<i data-ui="icon" data-name="' + name + '"></i>'; };
    var html = '<div data-part="header"><div data-part="caption">' + MONTHS[m] + " " + y + '<span data-part="view-switch">' + icon("arrow-drop-down") + '</span></div><div data-part="nav"><button data-ui="icon-button" data-edge="start" data-size="small" data-step-month="-1" aria-label="Previous month">' + icon("chevron-left") + '</button><button data-ui="icon-button" data-edge="end" data-size="small" data-step-month="1" aria-label="Next month">' + icon("chevron-right") + "</button></div></div>";
    html += '<div data-part="weekdays">' + "S M T W T F S".split(" ").map(function (w) { return '<span data-part="weekday">' + w + "</span>"; }).join("") + "</div>";
    var cells = "";
    for (var n = 0; n < first; n++) cells += '<span data-part="filler"></span>';
    for (var day = 1; day <= days; day++) {
      var date = y + "-" + pad(m + 1) + "-" + pad(day);
      cells += '<button data-part="day" data-date="' + date + '"' + (date === today ? ' data-today="true"' : "") + (date === c.dataset.selected ? ' aria-selected="true"' : "") + ">" + day + "</button>";
      if ((first + day) % 7 === 0 && day < days) cells += '</div><div data-part="week">';
    }
    var rest = (7 - (first + days) % 7) % 7;
    for (n = 0; n < rest; n++) cells += '<span data-part="filler"></span>';
    c.innerHTML = html + '<div data-part="week">' + cells + "</div>";
  }

  /* Slider: --from and --to mirror the thumbs; a second thumb can't cross the first. */
  function syncSlider(box, moved) {
    var thumbs = all(box, 'input[data-part="thumb"]');
    if (thumbs.length > 1 && moved) {
      var a = +thumbs[0].value, b = +thumbs[1].value;
      if (a > b) { if (moved === thumbs[0]) thumbs[0].value = b; else thumbs[1].value = a; }
    }
    var scale = function (t) { var lo = +(t.min || 0), hi = +(t.max || 100); return ((+t.value - lo) / (hi - lo)) * 100; };
    box.style.setProperty("--to", scale(thumbs[thumbs.length - 1]));
    if (thumbs.length > 1) box.style.setProperty("--from", scale(thumbs[0]));
  }

  /* Autocomplete: filter the options as you type. */
  function filter(box) {
    var input = box.querySelector('[data-part="input"]'), popup = box.querySelector('[data-part="popup"]');
    if (!input || !popup) return;
    var q = input.value.trim().toLowerCase(), any = false;
    all(popup, '[data-part="option"]').forEach(function (o) { var hit = o.textContent.toLowerCase().indexOf(q) >= 0; o.hidden = !hit; o.style.display = hit ? "" : "none"; any = any || hit; });
    var none = popup.querySelector('[data-part="no-options"]');
    if (none) none.hidden = any;
  }

  /* Transfer list */
  function transfer(btn, how) {
    var box = near(btn, '[data-ui="transfer-list"]');
    var lists = all(box, '[data-ui="list"]');
    if (lists.length < 2) return;
    var from = how.indexOf("right") >= 0 ? lists[0] : lists[1], to = from === lists[0] ? lists[1] : lists[0];
    all(from, '[data-part="item"]').forEach(function (it) {
      var check = it.querySelector("input");
      if (how.indexOf("all") === 0 || (check && check.checked)) { if (check) check.checked = false; to.appendChild(it); }
    });
  }

  /* Grid sorting */
  function sortGrid(th) {
    var table = near(th, "table"), body = table.tBodies[0];
    var next = th.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
    all(table, "th[aria-sort]").forEach(function (o) { if (o !== th) o.removeAttribute("aria-sort"); });
    th.setAttribute("aria-sort", next);
    var col = th.cellIndex, sign = next === "ascending" ? 1 : -1;
    var value = function (row) { return row.cells[col].textContent.trim().replace(/,/g, ""); };
    Array.prototype.slice.call(body.rows).sort(function (a, b) {
      var x = value(a), y = value(b);
      return sign * (isNaN(x) || isNaN(y) ? x.localeCompare(y) : x - y);
    }).forEach(function (row) { body.appendChild(row); });
  }

  d.addEventListener("pointerdown", ripple);

  d.addEventListener("click", function (e) {
    var t = e.target;
    if (!t.closest) return;
    var open = t.closest("[data-dialog-open]");
    if (open) { var dlg = d.getElementById(open.getAttribute("data-dialog-open")); if (dlg && dlg.showModal && !dlg.open) { e.preventDefault(); dlg.showModal(); } return; }
    var shut = t.closest("[data-dialog-close]");
    if (shut) { var mine = near(shut, "dialog"); if (mine) mine.close(); return; }
    if (t.matches('dialog[data-ui="dialog"], dialog[data-ui="modal"], dialog[data-ui="drawer"]')) { var box = t.getBoundingClientRect(); if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) t.close(); return; }

    var tab = t.closest('[data-ui="tabs"] [role="tab"]');
    if (tab) return pick(tab);

    var opt = t.closest('[data-ui="select"] [data-part="item"]');
    if (opt) {
      var sel = near(opt, '[data-ui="select"]'), val = sel.querySelector('[data-part="value"]');
      all(sel, '[data-part="item"]').forEach(function (o) { o.setAttribute("aria-selected", o === opt ? "true" : "false"); });
      if (val) val.textContent = opt.textContent;
      return hide(near(opt, "[popover]"));
    }
    var hit = t.closest('[data-ui="autocomplete"] [data-part="option"]');
    if (hit) { var auto = near(hit, '[data-ui="autocomplete"]'); auto.querySelector('[data-part="input"]').value = hit.textContent; filter(auto); return hide(near(hit, "[popover]")); }
    var clear = t.closest('[data-ui="autocomplete"] [data-part="clear"]');
    if (clear) { var cbox = near(clear, '[data-ui="autocomplete"]'), ci = cbox.querySelector('[data-part="input"]'); ci.value = ""; filter(cbox); ci.focus(); return; }
    var item = t.closest('[data-ui="menu"] [data-part="item"]');
    if (item) return hide(near(item, "[popover]"));

    var step = t.closest('[data-ui="number-field"] [data-part="step"]');
    if (step) {
      var num = near(step, '[data-ui="number-field"]').querySelector('[data-part="input"]');
      var was = parseFloat(num.value) || 0, by = step.getAttribute("data-step") === "up" ? 1 : -1;
      var lo = num.getAttribute("min"), hi = num.getAttribute("max"), next = was + by;
      if (lo !== null) next = Math.max(+lo, next);
      if (hi !== null) next = Math.min(+hi, next);
      num.value = next;
      return;
    }
    var toggle = t.closest('[data-ui="toggle-button"]');
    if (toggle) {
      var group = near(toggle, '[data-ui="toggle-button-group"]'), pressed = toggle.getAttribute("aria-pressed") === "true";
      if (group && group.dataset.exclusive !== "false") all(group, '[data-ui="toggle-button"]').forEach(function (o) { o.setAttribute("aria-pressed", "false"); });
      toggle.setAttribute("aria-pressed", pressed ? "false" : "true");
      return;
    }
    var move = t.closest("[data-step-month]");
    if (move) {
      var cal = near(move, '[data-ui="date-calendar"]'), parts = (cal.dataset.month || "").split("-");
      var when = parts.length === 2 ? new Date(+parts[0], +parts[1] - 1 + +move.getAttribute("data-step-month"), 1) : new Date();
      cal.dataset.month = when.getFullYear() + "-" + pad(when.getMonth() + 1);
      return drawCalendar(cal);
    }
    var day = t.closest('[data-ui="date-calendar"] [data-part="day"]');
    if (day) {
      var dc = near(day, '[data-ui="date-calendar"]'), chosen = day.getAttribute("data-date");
      dc.dataset.selected = chosen;
      all(dc, '[data-part="day"]').forEach(function (o) { if (o === day) o.setAttribute("aria-selected", "true"); else o.removeAttribute("aria-selected"); });
      var picker = near(dc, '[data-ui="date-picker"]');
      if (picker) { var bits = chosen.split("-"); picker.querySelector('[data-part="input"]').value = bits[1] + "/" + bits[2] + "/" + bits[0]; hide(near(dc, "[popover]")); }
      return;
    }
    var cell = t.closest('[data-ui="time-picker"] [data-part="cell"]');
    if (cell) {
      all(cell.parentElement, '[data-part="cell"]').forEach(function (o) { o.setAttribute("aria-selected", o === cell ? "true" : "false"); });
      var tp = near(cell, '[data-ui="time-picker"]'), on = all(tp, '[data-part="cell"][aria-selected="true"]').map(function (o) { return o.textContent; });
      if (on.length === 3) tp.querySelector('[data-part="input"]').value = on[0] + ":" + on[1] + " " + on[2];
      return;
    }
    var row = t.closest('[data-ui="tree-view"] [data-part="content"]');
    if (row) {
      var node = row.parentElement, tree = near(row, '[data-ui="tree-view"]');
      if (node.hasAttribute("aria-expanded")) node.setAttribute("aria-expanded", node.getAttribute("aria-expanded") === "true" ? "false" : "true");
      all(tree, '[aria-selected="true"]').forEach(function (o) { o.removeAttribute("aria-selected"); });
      node.setAttribute("aria-selected", "true");
      return;
    }
    var sort = t.closest('[data-ui="data-grid"] [data-part="sort"]');
    if (sort) return sortGrid(near(sort, "th"));
    var mv = t.closest("[data-transfer]");
    if (mv) return transfer(mv, mv.getAttribute("data-transfer"));
    var dest = t.closest('[data-ui="bottom-navigation"] [data-part="action"]');
    if (dest) { all(dest.parentElement, '[data-part="action"]').forEach(function (o) { if (o === dest) o.setAttribute("aria-current", "page"); else o.removeAttribute("aria-current"); }); return; }
  });

  d.addEventListener("input", function (e) {
    var t = e.target;
    var slider = near(t, '[data-ui="slider"]');
    if (slider) return syncSlider(slider, t);
    var rating = near(t, '[data-ui="rating"]');
    if (rating) return rating.style.setProperty("--value", t.value);
    var auto = near(t, '[data-ui="autocomplete"]');
    if (auto) { filter(auto); var pop = auto.querySelector('[data-part="popup"]'); if (pop && pop.showPopover && !pop.matches(":popover-open")) pop.showPopover(); }
  });

  d.addEventListener("change", function (e) {
    var t = e.target;
    var row = near(t, '[data-ui="data-grid"] tr');
    if (!row || !t.matches('input[type="checkbox"]')) return;
    var grid = near(row, '[data-ui="data-grid"]');
    if (row.parentElement.tagName === "THEAD") all(grid, 'tbody input[type="checkbox"]').forEach(function (c) { c.checked = t.checked; });
    all(grid, "tbody tr").forEach(function (r) { var c = r.querySelector("input"); if (c && c.checked) r.setAttribute("aria-selected", "true"); else r.removeAttribute("aria-selected"); });
    var note = grid.querySelector('[data-part="selected"]'), count = all(grid, 'tbody tr[aria-selected="true"]').length;
    if (note) note.textContent = count ? count + (count === 1 ? " row selected" : " rows selected") : "";
  });

  d.addEventListener("keydown", function (e) {
    var tab = near(e.target, '[data-ui="tabs"] [role="tab"]');
    if (!tab || (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    var list = all(tab.parentElement, '[role="tab"]:not(:disabled)'), at = list.indexOf(tab);
    var by = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    e.preventDefault();
    pick(list[(at + by + list.length) % list.length], true);
  });

  /* A snackbar leaves on its own after six seconds. */
  d.addEventListener("toggle", function (e) {
    var t = e.target;
    if (t.matches && t.matches('[data-ui="snackbar"]') && e.newState === "open") setTimeout(function () { hide(t); }, 6000);
  }, true);

  function init() {
    all(d, '[data-ui="date-calendar"]').forEach(drawCalendar);
    all(d, '[data-ui="slider"]').forEach(function (s) { if (s.querySelector('input[data-part="thumb"]')) syncSlider(s); });
    var bars = all(d, '[data-ui="tabs"] > [data-part="list"]');
    bars.forEach(placeBar);
    if (window.ResizeObserver) { var watch = new ResizeObserver(function (list) { list.forEach(function (r) { placeBar(r.target); }); }); bars.forEach(function (b) { watch.observe(b); }); }
    if (d.fonts && d.fonts.ready) d.fonts.ready.then(function () { bars.forEach(placeBar); });
  }
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", init); else init();
})();
