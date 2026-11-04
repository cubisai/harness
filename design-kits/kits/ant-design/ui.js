/* Ant Design kit behaviour: wave, tabs, dialogs, select, cascader, pickers, calendar, tree, transfer, sliders, rate, colour
 * picker, upload, table, pagination, carousel, splitter, tour, notices. Safe on any page. */
(function () {
  "use strict";
  var d = document, pad = function (n) { return ("0" + n).slice(-2); };
  var all = function (r, s) { return Array.prototype.slice.call(r.querySelectorAll(s)); };
  var near = function (el, s) { return el && el.closest ? el.closest(s) : null; };
  var part = function (r, n) { return r.querySelector('[data-part="' + n + '"]'); };
  var hide = function (p) { if (p && p.matches(":popover-open")) p.hidePopover(); };
  var show = function (p) { if (p && p.showPopover && !p.matches(":popover-open")) p.showPopover(); };
  var icon = function (n) { return '<i data-ui="icon" data-name="' + n + '"></i>'; };
  var one = function (list, on, a) { list.forEach(function (o) { o.setAttribute(a, o === on ? "true" : "false"); }); };

  /* Wave: a ring that leaves the button when it's clicked. */
  var calm = window.matchMedia("(prefers-reduced-motion: reduce)");
  function wave(b) {
    if (calm.matches || !b.animate) return;
    var c = getComputedStyle(b).getPropertyValue("--c");
    b.animate([{ boxShadow: "0 0 0 0 " + c, opacity: 0.2 }, { boxShadow: "0 0 0 6px " + c, opacity: 0 }], { duration: 400, easing: "cubic-bezier(0.08, 0.82, 0.17, 1)", pseudoElement: "::after" });
  }

  /* Tabs */
  function ink(list) {
    var on = list.querySelector('[role="tab"][aria-selected="true"]');
    if (!on) return;
    var bar = part(list, "ink");
    if (!bar) { bar = d.createElement("span"); bar.setAttribute("data-part", "ink"); list.appendChild(bar); list.setAttribute("data-slides", "true"); }
    var tall = near(list, '[data-tab-placement="start"]');
    bar.style.left = tall ? "" : on.offsetLeft + "px"; bar.style.width = tall ? "" : on.offsetWidth + "px";
    bar.style.top = tall ? on.offsetTop + "px" : ""; bar.style.height = tall ? on.offsetHeight + "px" : "";
  }
  function pick(tab, focus) {
    var box = near(tab, '[data-ui="tabs"]');
    all(box, '[role="tab"]').forEach(function (t) {
      var on = t === tab, p = d.getElementById(t.getAttribute("aria-controls"));
      t.setAttribute("aria-selected", on ? "true" : "false"); t.setAttribute("tabindex", on ? "0" : "-1");
      if (p) p.hidden = !on;
    });
    ink(tab.parentElement);
    if (focus) tab.focus();
  }

  /* Calendar and date panel: drawn from data-month, data-selected and data-events. */
  var MONTHS = "January February March April May June July August September October November December".split(" ");
  function draw(c) {
    var now = new Date(), full = c.matches('[data-ui="calendar"]:not([data-fullscreen="false"])');
    var ym = (c.dataset.month || now.getFullYear() + "-" + pad(now.getMonth() + 1)).split("-"), y = +ym[0], m = +ym[1] - 1;
    var today = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()), events = {};
    (c.dataset.events || "").split(";").forEach(function (e) { var b = e.split(":"); if (b[2]) (events[b[0]] = events[b[0]] || []).push(b); });
    var nav = function (n, by, label) { return '<button data-part="nav" type="button" data-by="' + by + '" aria-label="' + label + '">' + icon(n) + "</button>"; };
    var html;
    if (full) {
      html = '<div data-part="bar"><select data-ui="input" data-part="year" aria-label="Year">';
      for (var yy = y - 5; yy <= y + 5; yy++) html += "<option" + (yy === y ? " selected" : "") + ">" + yy + "</option>";
      html += '</select><select data-ui="input" data-part="month" aria-label="Month">' + MONTHS.map(function (n, k) { return '<option value="' + k + '"' + (k === m ? " selected" : "") + ">" + n.slice(0, 3) + "</option>"; }).join("") + "</select></div>";
    } else {
      html = '<div data-part="header">' + nav("double-left", -12, "Previous year") + nav("left", -1, "Previous month") + '<div data-part="caption">' + MONTHS[m].slice(0, 3) + " " + y + "</div>" + nav("right", 1, "Next month") + nav("double-right", 12, "Next year") + "</div>";
    }
    html += '<div data-part="body"><table><thead><tr>' + "Su Mo Tu We Th Fr Sa".split(" ").map(function (w) { return "<th>" + w + "</th>"; }).join("") + "</tr></thead><tbody>";
    var first = new Date(y, m, 1).getDay();
    for (var w = 0; w < 6; w++) {
      html += "<tr>";
      for (var k = 0; k < 7; k++) {
        var at = new Date(y, m, 1 + w * 7 + k - first), date = at.getFullYear() + "-" + pad(at.getMonth() + 1) + "-" + pad(at.getDate());
        html += '<td><button data-part="day" type="button" data-date="' + date + '"' + (at.getMonth() !== m ? ' data-outside="true"' : "") + (date === today ? ' data-today="true"' : "") + (date === c.dataset.selected ? ' aria-selected="true"' : "") + ">" + at.getDate();
        if (full && events[date]) html += '<span data-part="events">' + events[date].map(function (e) { return '<span data-part="event" data-type="' + e[1] + '">' + e[2] + "</span>"; }).join("") + "</span>";
        html += "</button></td>";
      }
      html += "</tr>";
    }
    c.innerHTML = html + "</tbody></table></div>" + (c.matches('[data-part="panel"]') ? '<div data-part="foot"><button data-ui="button" data-type="link" data-size="small" data-part="today" type="button">Today</button></div>' : "");
  }
  var month = function (c, by) { var p = (c.dataset.month || "").split("-"), n = new Date(+p[0], +p[1] - 1 + by, 1); c.dataset.month = n.getFullYear() + "-" + pad(n.getMonth() + 1); draw(c); };
  function chooseDay(c, date) {
    c.dataset.selected = date; c.dataset.month = date.slice(0, 7); draw(c);
    var p = near(c, '[data-ui="date-picker"]');
    if (p) { p.querySelector('[data-part="field"]').value = date; hide(part(p, "popup")); }
  }

  /* Time columns */
  function drawTime(t) {
    var v = (t.dataset.value || "00:00:00").split(":"), cols = part(t, "columns");
    if (!cols) return;
    cols.innerHTML = [24, 60, 60].map(function (n, k) { var h = '<div data-part="column">'; for (var i = 0; i < n; i++) h += '<button data-part="cell" type="button"' + (pad(i) === v[k] ? ' aria-selected="true"' : "") + ">" + pad(i) + "</button>"; return h + "</div>"; }).join("");
  }
  var scrollTime = function (t) { all(t, '[data-part="column"]').forEach(function (c) { var s = c.querySelector('[aria-selected="true"]'); if (s) c.scrollTop = s.offsetTop - c.offsetTop; }); };
  function setTime(t, value) { t.dataset.value = value; t.querySelector('[data-part="field"]').value = value; }

  /* Filter a popup's options. */
  function filter(p, q) { var any = false; all(p, '[data-part="option"]').forEach(function (o) { var hit = o.textContent.toLowerCase().indexOf(q) >= 0; o.style.display = hit ? "" : "none"; any = any || hit; }); return any; }

  /* Slider and colour picker */
  function slide(box, moved) {
    var th = all(box, 'input[data-part="thumb"]');
    if (th.length > 1 && moved && +th[0].value > +th[1].value) { if (moved === th[0]) th[0].value = th[1].value; else th[1].value = th[0].value; }
    var at = function (t) { var lo = +(t.min || 0), hi = +(t.max || 100); return ((+t.value - lo) / (hi - lo)) * 100; };
    box.style.setProperty("--to", at(th[th.length - 1]));
    if (th.length > 1) box.style.setProperty("--from", at(th[0]));
  }
  function hsv(h, s, v) { var f = function (n) { var k = (n + h / 60) % 6; return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255); }; return "#" + [f(5), f(3), f(1)].map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join("").toUpperCase(); }
  function paint(cp, s, v) {
    var h = +part(cp, "hue").value, o = cp._sv = { s: s === undefined ? (cp._sv ? cp._sv.s : 0.91) : s, v: v === undefined ? (cp._sv ? cp._sv.v : 1) : v };
    var hex = hsv(h, o.s, o.v);
    cp.style.setProperty("--color", hex); cp.style.setProperty("--pad", hsv(h, 1, 1));
    part(cp, "text").textContent = hex; part(cp, "hex").value = hex;
    var t = part(cp, "pad-thumb"); t.style.setProperty("--x", o.s * 100 + "%"); t.style.setProperty("--y", (1 - o.v) * 100 + "%");
  }

  function count(list) { var n = all(list, '[data-part="item"]').length, c = part(list, "count"); if (c) c.textContent = n + (n === 1 ? " item" : " items"); }

  /* Tour */
  function tourPlace(t) {
    var s = all(t, '[data-part="step"]'), at = +t.dataset.at || 0, step = s[at];
    s.forEach(function (x, k) { x.hidden = k !== at; });
    var el = d.getElementById(step.dataset.target), r = el.getBoundingClientRect(), spot = part(t, "spot"), card = part(t, "card");
    spot.style.cssText = "left:" + (r.left - 6) + "px;top:" + (r.top - 6) + "px;width:" + (r.width + 12) + "px;height:" + (r.height + 12) + "px";
    card.style.left = Math.max(16, Math.min(r.left, innerWidth - 316)) + "px"; card.style.top = (r.bottom + 240 > innerHeight ? Math.max(16, r.top - 170) : r.bottom + 16) + "px";
    part(t, "dots").innerHTML = s.map(function (x, k) { return "<span" + (k === at ? ' aria-current="step"' : "") + "></span>"; }).join("");
    part(t, "prev").hidden = at === 0; part(t, "next").textContent = at === s.length - 1 ? "Finish" : "Next";
  }

  d.addEventListener("click", function (e) {
    var t = e.target;
    if (!t.closest) return;
    var at = function (ui, p) { return t.closest('[data-ui="' + ui + '"] [data-part="' + p + '"]'); };
    var b = t.closest('[data-ui="button"]');
    if (b && !b.disabled) wave(b);
    var open = t.closest("[data-dialog-open]");
    if (open) { var dg = d.getElementById(open.getAttribute("data-dialog-open")); if (dg && dg.showModal && !dg.open) { e.preventDefault(); dg.showModal(); } return; }
    var shut = t.closest("[data-dialog-close]");
    if (shut) { var m = near(shut, "dialog"); if (m) m.close(); return; }
    if (t.matches('dialog[data-ui="modal"], dialog[data-ui="drawer"], dialog[data-part="preview"]')) { var r = t.getBoundingClientRect(); if (t.matches('[data-part="preview"]') || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) t.close(); return; }

    var tab = t.closest('[data-ui="tabs"] [role="tab"]');
    if (tab) return pick(tab);

    var chip = t.closest('[data-part="chip-close"]');
    if (chip) { e.preventDefault(); var cs = near(chip, '[data-ui="select"]'), name = chip.parentElement.textContent; all(cs, '[data-part="option"]').forEach(function (o) { if (o.textContent === name) o.setAttribute("aria-selected", "false"); }); chip.parentElement.remove(); return; }
    var opt = at("select", "option");
    if (opt) {
      var sel = near(opt, '[data-ui="select"]'), val = part(sel, "value");
      if (sel.dataset.mode === "multiple") {
        opt.setAttribute("aria-selected", opt.getAttribute("aria-selected") === "true" ? "false" : "true");
        val.innerHTML = all(sel, '[data-part="option"][aria-selected="true"]').map(function (o) { return '<span data-part="chip">' + o.textContent + '<i data-ui="icon" data-name="close" data-part="chip-close"></i></span>'; }).join("");
        return;
      }
      one(all(sel, '[data-part="option"]'), opt, "aria-selected");
      val.textContent = opt.textContent;
      return hide(near(opt, "[popover]"));
    }
    var ac = at("auto-complete", "option");
    if (ac) { var au = near(ac, '[data-ui="auto-complete"]'); au.querySelector("input").value = ac.textContent; return hide(part(au, "popup")); }
    var men = at("mentions", "option");
    if (men) { var mb = near(men, '[data-ui="mentions"]'), ta = mb.querySelector("textarea"); ta.value = ta.value.replace(/@\w*$/, "@" + men.textContent + " "); hide(part(mb, "popup")); ta.focus(); return; }

    var co = at("cascader", "option");
    if (co) {
      var ca = near(co, '[data-ui="cascader"]'), path = co.dataset.path, lvl = +near(co, '[data-part="column"]').dataset.level;
      all(ca, '[data-part="column"]').forEach(function (c) { if (+c.dataset.level > lvl) c.hidden = c.dataset.parent !== path; });
      all(near(co, '[data-part="column"]'), '[data-part="option"]').forEach(function (o) { o.removeAttribute("aria-expanded"); });
      co.setAttribute("aria-expanded", "true");
      if (co.dataset.leaf) { var trail = all(ca, '[aria-expanded="true"]').filter(function (o) { return !near(o, "[hidden]"); }).map(function (o) { return o.textContent; }); var cv = part(ca, "value"); cv.textContent = trail.join(" / "); cv.removeAttribute("data-placeholder"); hide(part(ca, "popup")); }
      return;
    }

    var nav = t.closest('[data-part="nav"][data-by]');
    if (nav) return month(near(nav, "[data-month]"), +nav.dataset.by);
    var day = t.closest('[data-part="day"]');
    if (day) return chooseDay(near(day, "[data-month]"), day.dataset.date);
    var td = t.closest('[data-part="today"]');
    if (td) { var n = new Date(); return chooseDay(near(td, "[data-month]"), n.getFullYear() + "-" + pad(n.getMonth() + 1) + "-" + pad(n.getDate())); }

    var cell = at("time-picker", "cell");
    if (cell) { var tp = near(cell, '[data-ui="time-picker"]'); one(all(cell.parentElement, '[data-part="cell"]'), cell, "aria-selected"); setTime(tp, all(tp, '[data-part="cell"][aria-selected="true"]').map(function (o) { return o.textContent; }).join(":")); return; }
    var now = at("time-picker", "now");
    if (now) { var nt = near(now, '[data-ui="time-picker"]'), w = new Date(); setTime(nt, pad(w.getHours()) + ":" + pad(w.getMinutes()) + ":" + pad(w.getSeconds())); drawTime(nt); hide(part(nt, "popup")); return; }
    var ok = at("time-picker", "ok");
    if (ok) return hide(near(ok, "[popover]"));

    var sw = at("tree", "switcher");
    if (sw) { var nd = near(sw, '[data-part="node"]'); if (nd.hasAttribute("aria-expanded")) nd.setAttribute("aria-expanded", nd.getAttribute("aria-expanded") === "true" ? "false" : "true"); return; }
    var ti = at("tree", "title");
    if (ti) {
      var tree = near(ti, '[data-ui="tree"]');
      all(tree, '[aria-selected="true"]').forEach(function (o) { o.removeAttribute("aria-selected"); });
      near(ti, '[data-part="node"]').setAttribute("aria-selected", "true");
      var ts = near(ti, '[data-ui="tree-select"]');
      if (ts) { var tv = part(ts, "value"); tv.textContent = ti.textContent; tv.removeAttribute("data-placeholder"); hide(part(ts, "popup")); }
      return;
    }
    var mv = t.closest("[data-transfer]");
    if (mv) {
      var box = near(mv, '[data-ui="transfer"]'), ls = all(box, '[data-part="list"]'), right = mv.dataset.transfer === "right", from = ls[right ? 0 : 1], to = ls[right ? 1 : 0];
      all(from, '[data-part="item"]').forEach(function (it) { var ck = it.querySelector("input"); if (ck.checked) { ck.checked = false; part(to, "body").appendChild(it); } });
      ls.forEach(function (l) { count(l); part(l, "all").checked = false; });
      return;
    }
    var st = at("input-number", "step");
    if (st) {
      var f = near(st, '[data-ui="input-number"]').querySelector('[data-part="field"]'), by = +st.dataset.step * (+f.getAttribute("step") || 1), nv = (parseFloat(f.value) || 0) + by;
      if (f.getAttribute("min") !== null) nv = Math.max(+f.getAttribute("min"), nv);
      if (f.getAttribute("max") !== null) nv = Math.min(+f.getAttribute("max"), nv);
      f.value = nv; return;
    }
    var rv = t.closest('[data-part="reveal"]');
    if (rv) { var pw = near(rv, '[data-ui="input"]').querySelector("input"), vis = pw.type === "password"; pw.type = vis ? "text" : "password"; rv.innerHTML = icon(vis ? "eye" : "eye-invisible"); rv.setAttribute("aria-label", vis ? "Hide password" : "Show password"); return; }
    var rm = at("upload", "remove");
    if (rm) return near(rm, '[data-part="item"]').remove();
    var cl = t.closest('[data-ui="tag"] [data-part="close"], [data-ui="alert"] [data-part="close"]');
    if (cl) return cl.parentElement.remove();
    var sort = at("table", "sort");
    if (sort) {
      var th = near(sort, "th"), tb = near(th, "table"), bd = tb.tBodies[0], dir = th.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending", col = th.cellIndex, sign = dir === "ascending" ? 1 : -1;
      all(tb, "th[aria-sort]").forEach(function (o) { o.setAttribute("aria-sort", "none"); }); th.setAttribute("aria-sort", dir);
      var v = function (row) { return row.cells[col].textContent.trim().replace(/,/g, ""); };
      Array.prototype.slice.call(bd.rows).sort(function (x, y) { var a = v(x), c = v(y); return sign * (isNaN(a) || isNaN(c) ? a.localeCompare(c) : a - c); }).forEach(function (row) { bd.appendChild(row); });
      return;
    }
    var pg = t.closest('[data-ui="pagination"] :is([data-part="item"], [data-part="prev"], [data-part="next"])');
    if (pg && !pg.disabled) {
      var nv2 = near(pg, '[data-ui="pagination"]'), items = all(nv2, '[data-part="item"]'), cur = items.filter(function (o) { return o.hasAttribute("aria-current"); })[0], go = pg.dataset.part === "item" ? pg : items[items.indexOf(cur) + (pg.dataset.part === "next" ? 1 : -1)];
      if (!go) return;
      cur.removeAttribute("aria-current"); go.setAttribute("aria-current", "page");
      part(nv2, "prev").disabled = go === items[0]; part(nv2, "next").disabled = go === items[items.length - 1];
      return;
    }
    var al = at("anchor", "link");
    if (al) { all(near(al, '[data-ui="anchor"]'), "[aria-current]").forEach(function (o) { o.removeAttribute("aria-current"); }); al.setAttribute("aria-current", "location"); return; }
    var dot = at("carousel", "dot") || at("carousel", "arrow");
    if (dot) {
      var car = near(dot, '[data-ui="carousel"]'), tr = part(car, "track"), dots = all(car, '[data-part="dot"]'), now2 = Math.round(tr.scrollLeft / tr.clientWidth);
      var to2 = dot.dataset.part === "dot" ? dots.indexOf(dot) : (at + +dot.dataset.dir + dots.length) % dots.length;
      tr.scrollTo({ left: to2 * tr.clientWidth }); return;
    }
    var open2 = t.closest("[data-tour-open]");
    if (open2) { var tour = d.getElementById(open2.dataset.tourOpen); tour.dataset.at = 0; tour.showPopover(); tourPlace(tour); return; }
    var tc = near(t, '[data-ui="tour"]');
    if (tc) {
      var steps = all(tc, '[data-part="step"]').length, here = +tc.dataset.at || 0;
      if (t.closest('[data-part="close"]')) return tc.hidePopover();
      if (t.closest('[data-part="next"]')) { if (here === steps - 1) return tc.hidePopover(); tc.dataset.at = here + 1; tourPlace(tc); }
      if (t.closest('[data-part="prev"]')) { tc.dataset.at = here - 1; tourPlace(tc); }
    }
  });

  d.addEventListener("input", function (e) {
    var t = e.target;
    var sl = near(t, '[data-ui="slider"]');
    if (sl) return slide(sl, t);
    var ra = near(t, '[data-ui="rate"]');
    if (ra) return ra.style.setProperty("--value", t.value);
    var au = near(t, '[data-ui="auto-complete"]');
    if (au) { var p = part(au, "popup"); if (filter(p, t.value.trim().toLowerCase())) show(p); else hide(p); return; }
    var me = near(t, '[data-ui="mentions"]');
    if (me) { var pop = part(me, "popup"), hit = /@(\w*)$/.exec(t.value); if (hit && filter(pop, hit[1].toLowerCase())) show(pop); else hide(pop); return; }
    var cp = near(t, '[data-ui="color-picker"]');
    if (cp && t.matches('[data-part="hue"]')) return paint(cp);
    var otp = near(t, '[data-ui="input-otp"]');
    if (otp && t.value && t.nextElementSibling) t.nextElementSibling.focus();
  });

  d.addEventListener("change", function (e) {
    var t = e.target;
    if (t.matches('[data-ui="table"] input[type="checkbox"]')) {
      var tb = near(t, "table");
      if (t.dataset.part === "all") all(tb, 'tbody input[type="checkbox"]').forEach(function (c) { c.checked = t.checked; });
      all(tb, "tbody tr").forEach(function (r) { var c = r.querySelector("input"); if (c && c.checked) r.setAttribute("aria-selected", "true"); else r.removeAttribute("aria-selected"); });
      return;
    }
    if (t.matches('[data-ui="transfer"] [data-part="all"]')) { all(near(t, '[data-part="list"]'), '[data-part="item"] input').forEach(function (c) { c.checked = t.checked; }); return; }
    if (t.matches('[data-ui="upload"] [data-part="input"]') && t.files.length) {
      var up = near(t, '[data-ui="upload"]'), list = part(up, "list");
      if (list && !up.dataset.listType) Array.prototype.forEach.call(t.files, function (f) { var li = d.createElement("li"); li.setAttribute("data-part", "item"); li.innerHTML = icon("paper-clip") + '<span data-part="name"></span><button data-part="remove" type="button" aria-label="Remove">' + icon("delete") + "</button>"; li.querySelector("span").textContent = f.name; list.appendChild(li); });
      return;
    }
    var cal = t.matches('select[data-part="year"], select[data-part="month"]') && near(t, '[data-ui="calendar"]');
    if (cal) { cal.dataset.month = part(cal, "year").value + "-" + pad(+part(cal, "month").value + 1); draw(cal); return; }
    var hx = t.matches('[data-ui="color-picker"] [data-part="hex"]') && near(t, '[data-ui="color-picker"]');
    if (hx && /^#[0-9a-f]{6}$/i.test(t.value)) { hx.style.setProperty("--color", t.value); part(hx, "text").textContent = t.value.toUpperCase(); }
  });

  d.addEventListener("focusin", function (e) {
    var f = near(e.target, '[data-ui="date-picker"] [data-part="field"], [data-ui="time-picker"] [data-part="field"], [data-ui="auto-complete"] input');
    if (f) show(part(near(f, '[data-ui="date-picker"], [data-ui="time-picker"], [data-ui="auto-complete"]'), "popup"));
  });

  /* Drags: the splitter's bar and the colour pad. */
  d.addEventListener("pointerdown", function (e) {
    var bar = near(e.target, '[data-ui="splitter"] [data-part="bar"]'), padEl = near(e.target, '[data-ui="color-picker"] [data-part="pad"]');
    if (!bar && !padEl) return;
    e.preventDefault();
    var move;
    if (bar) {
      var sp = bar.parentElement, tall = sp.dataset.orientation === "vertical", prev = bar.previousElementSibling, r = sp.getBoundingClientRect();
      bar.dataset.dragging = "true";
      move = function (ev) { var at = tall ? (ev.clientY - r.top) / r.height : (ev.clientX - r.left) / r.width; prev.style.flex = "0 0 " + Math.min(90, Math.max(10, at * 100)) + "%"; };
    } else {
      var cp = near(padEl, '[data-ui="color-picker"]'), rc = padEl.getBoundingClientRect(), cl = function (n) { return Math.max(0, Math.min(1, n)); };
      move = function (ev) { paint(cp, cl((ev.clientX - rc.left) / rc.width), 1 - cl((ev.clientY - rc.top) / rc.height)); };
      move(e);
    }
    var up = function () { d.removeEventListener("pointermove", move); d.removeEventListener("pointerup", up); if (bar) bar.removeAttribute("data-dragging"); };
    d.addEventListener("pointermove", move); d.addEventListener("pointerup", up);
  });

  d.addEventListener("keydown", function (e) {
    var tab = near(e.target, '[data-ui="tabs"] [role="tab"]');
    if (!tab || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
    var list = all(tab.parentElement, '[role="tab"]:not(:disabled)');
    e.preventDefault();
    pick(list[(list.indexOf(tab) + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length], true);
  });

  /* Notices leave on their own; time columns scroll to the value as they open. */
  d.addEventListener("toggle", function (e) {
    var t = e.target;
    if (e.newState !== "open" || !t.matches) return;
    if (t.matches('[data-ui="message"]')) setTimeout(function () { hide(t); }, 3000);
    if (t.matches('[data-ui="notification"]')) setTimeout(function () { hide(t); }, 4500);
    if (t.matches('[data-ui="time-picker"] [data-part="popup"]')) scrollTime(t);
  }, true);

  function init() {
    all(d, '[data-ui="calendar"], [data-part="panel"][data-month]').forEach(draw);
    all(d, '[data-ui="time-picker"]').forEach(drawTime);
    all(d, '[data-ui="slider"]').forEach(function (s) { if (s.querySelector('input[data-part="thumb"]')) slide(s); });
    all(d, '[data-ui="carousel"] [data-part="track"]').forEach(function (tr) {
      tr.addEventListener("scroll", function () { var at = Math.round(tr.scrollLeft / tr.clientWidth); all(tr.parentElement, '[data-part="dot"]').forEach(function (o, k) { if (k === at) o.setAttribute("aria-current", "true"); else o.removeAttribute("aria-current"); }); }, { passive: true });
    });
    var bars = all(d, '[data-ui="tabs"] > [data-part="list"]');
    bars.forEach(ink);
    if (window.ResizeObserver) { var ro = new ResizeObserver(function (l) { l.forEach(function (r) { ink(r.target); }); }); bars.forEach(function (b) { ro.observe(b); }); }
  }
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", init); else init();
})();
