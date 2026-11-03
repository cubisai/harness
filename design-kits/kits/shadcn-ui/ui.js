/* shadcn/ui kit behaviour: tabs, dialogs, select, combobox, command, calendar, menus, carousel, toast, OTP, resize. Safe on any page. */
(function () {
  "use strict";
  var d = document;
  var all = function (root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); };
  var near = function (el, sel) { return el.closest ? el.closest(sel) : null; };
  var el = function (tag, attrs, html) { var n = d.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (html) n.innerHTML = html; return n; };
  var icon = function (name) { return '<i data-ui="icon" data-name="' + name + '"></i>'; };
  var hide = function (p) { if (p && p.matches(":popover-open")) p.hidePopover(); };

  /* Tabs */
  function pick(list, tab, focus) {
    list.forEach(function (t) {
      var on = t === tab;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.setAttribute("tabindex", on ? "0" : "-1");
      var panel = d.getElementById(t.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    });
    if (focus) tab.focus();
  }
  function tabsOf(tab) { var box = near(tab, '[data-ui="tabs"]'); return box ? all(box, '[role="tab"]') : []; }

  /* Calendar: drawn from data-month, data-selected or data-from and data-to. */
  var MONTHS = "January February March April May June July August September October November December".split(" ");
  var iso = function (y, m, day) { return y + "-" + ("0" + (m + 1)).slice(-2) + "-" + ("0" + day).slice(-2); };
  function drawCalendar(c) {
    var now = new Date();
    var ym = (c.dataset.month || iso(now.getFullYear(), now.getMonth(), 1)).split("-");
    var y = +ym[0], m = +ym[1] - 1;
    var first = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate(), prev = new Date(y, m, 0).getDate();
    var today = iso(now.getFullYear(), now.getMonth(), now.getDate());
    var a = c.dataset.from, b = c.dataset.to, one = c.dataset.selected;
    var html = '<div data-part="nav"><button data-ui="button" data-variant="ghost" data-size="icon-sm" data-part="prev" aria-label="Previous month">' + icon("chevron-left") + '</button><button data-ui="button" data-variant="ghost" data-size="icon-sm" data-part="next" aria-label="Next month">' + icon("chevron-right") + "</button></div>";
    if (c.dataset.caption === "label") html += '<div data-part="caption">' + MONTHS[m] + " " + y + "</div>";
    else {
      var pad = function (name, val, opts) { return '<label data-part="dropdown"><span>' + val + "</span>" + icon("chevron-down") + '<select aria-label="' + name + '" data-part="' + name + '">' + opts + "</select></label>"; };
      var mo = MONTHS.map(function (n, i) { return "<option value=" + i + (i === m ? " selected>" : ">") + n.slice(0, 3) + "</option>"; }).join("");
      var yr = ""; for (var i = y - 10; i <= y + 10; i++) yr += "<option" + (i === y ? " selected>" : ">") + i + "</option>";
      html += '<div data-part="caption">' + pad("month", MONTHS[m].slice(0, 3), mo) + pad("year", y, yr) + "</div>";
    }
    html += '<div><div data-part="weekdays">' + "Su Mo Tu We Th Fr Sa".split(" ").map(function (w) { return '<span data-part="weekday">' + w + "</span>"; }).join("") + '</div><div data-part="grid">';
    var cell = function (day, date, out) {
      var extra = out ? ' data-outside="true"' : "";
      if (date === today) extra += ' data-today="true"';
      if (date === one) extra += ' data-selected="true"';
      if (a && date === a) extra += ' data-range="start"';
      else if (b && date === b) extra += ' data-range="end"';
      else if (a && b && date > a && date < b) extra += ' data-range="middle"';
      return '<button data-part="day" data-date="' + date + '"' + extra + ">" + day + "</button>";
    };
    var total = Math.ceil((first + days) / 7) * 7;
    for (var n = 0; n < total; n++) {
      var at = n - first + 1;
      if (at < 1) html += cell(prev + at, iso(new Date(y, m - 1).getFullYear(), new Date(y, m - 1).getMonth(), prev + at), true);
      else if (at > days) html += cell(at - days, iso(new Date(y, m + 1).getFullYear(), new Date(y, m + 1).getMonth(), at - days), true);
      else html += cell(at, iso(y, m, at));
    }
    c.innerHTML = html + "</div></div>";
  }
  function shiftMonth(c, by) {
    var ym = (c.dataset.month || iso(new Date().getFullYear(), new Date().getMonth(), 1)).split("-");
    var t = new Date(+ym[0], +ym[1] - 1 + by, 1);
    c.dataset.month = iso(t.getFullYear(), t.getMonth(), 1).slice(0, 7);
    drawCalendar(c);
  }
  function chooseDay(c, date) {
    if (c.dataset.mode === "range") {
      if (!c.dataset.from || c.dataset.to) { c.dataset.from = date; delete c.dataset.to; }
      else if (date < c.dataset.from) { c.dataset.to = c.dataset.from; c.dataset.from = date; }
      else c.dataset.to = date;
    } else c.dataset.selected = date;
    drawCalendar(c);
    var dp = near(c, '[data-ui="date-picker"]');
    if (dp) {
      var v = dp.querySelector('[data-part="value"]'), p = date.split("-");
      if (v) { v.textContent = MONTHS[+p[1] - 1].slice(0, 3) + " " + +p[2] + ", " + p[0]; v.setAttribute("data-chosen", "true"); }
      hide(near(c, "[popover]"));
    }
  }

  d.addEventListener("click", function (e) {
    var t = e.target;
    if (!t.closest) return;
    var tab = t.closest('[role="tab"]');
    if (tab && tabsOf(tab).length) { e.preventDefault(); pick(tabsOf(tab), tab, true); return; }
    var open = t.closest("[data-dialog-open]");
    if (open) { var dlg = d.getElementById(open.getAttribute("data-dialog-open")); if (dlg && dlg.showModal && !dlg.open) { e.preventDefault(); dlg.showModal(); } return; }
    var close = t.closest("[data-dialog-close]");
    if (close) { var nd = close.closest("dialog"); if (nd) nd.close(); return; }
    /* A click on the dialog element itself landed on its backdrop. An alert dialog has to be answered. */
    if (t.tagName === "DIALOG" && t.open && t.getAttribute("data-ui") !== "alert-dialog") {
      var r = t.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) t.close();
    }
    var cal = t.closest('[data-ui="calendar"]');
    if (cal) {
      var day = t.closest('[data-part="day"]');
      if (day) { chooseDay(cal, day.dataset.date); return; }
      if (t.closest('[data-part="prev"]')) return shiftMonth(cal, -1);
      if (t.closest('[data-part="next"]')) return shiftMonth(cal, 1);
    }
    var opt = t.closest('[role="option"]');
    if (opt) {
      var box = near(opt, '[data-ui="select"],[data-ui="combobox"]');
      if (box) {
        all(box, '[role="option"]').forEach(function (o) { o.removeAttribute("aria-selected"); });
        opt.setAttribute("aria-selected", "true");
        var val = box.querySelector('[data-part="value"]');
        if (val) { val.textContent = opt.textContent; val.removeAttribute("data-placeholder"); }
        var inp = box.querySelector('input[data-part="control"]');
        if (inp) inp.value = opt.textContent;
        hide(near(opt, "[popover]"));
      }
      return;
    }
    var mi = t.closest('button[role="menuitem"]:not([popovertarget])');
    if (mi) { var pop = mi.closest("[popover]"); while (pop) { hide(pop); pop = pop.parentElement && pop.parentElement.closest("[popover]"); } return; }
    var pressed = t.closest('[data-ui="toggle"]');
    if (pressed) {
      var group = near(pressed, '[data-ui="toggle-group"]');
      if (group && group.dataset.type !== "multiple") all(group, '[data-ui="toggle"]').forEach(function (o) { if (o !== pressed) o.setAttribute("aria-pressed", "false"); });
      pressed.setAttribute("aria-pressed", pressed.getAttribute("aria-pressed") === "true" ? "false" : "true");
      return;
    }
    var car = t.closest('[data-ui="carousel"] > [data-part="previous"], [data-ui="carousel"] > [data-part="next"]');
    if (car) { var track = car.parentElement.querySelector('[data-part="content"]'); track.scrollBy({ left: (car.dataset.part === "next" ? 1 : -1) * track.clientWidth, behavior: "smooth" }); return; }
    var toast = t.closest("[data-toast-open]");
    if (toast) { var box2 = d.getElementById(toast.getAttribute("data-toast-open")); if (box2 && box2.showPopover) { if (!box2.matches(":popover-open")) box2.showPopover(); clearTimeout(box2._t); box2._t = setTimeout(function () { hide(box2); }, 4000); } return; }
    var tc = t.closest('[data-ui="toast"] [data-part="close"], [data-ui="toast"] [data-part="action"]');
    if (tc) return hide(tc.closest("[popover]"));
    var trig = t.closest('[data-ui="sidebar"] [data-part="trigger"], [data-part="inset"] [data-part="trigger"]');
    if (trig) { var host = trig.closest('[data-part="wrapper"], [data-ui="dashboard"]'); var sb = host && host.querySelector('[data-ui="sidebar"]'); if (sb) sb.dataset.state = sb.dataset.state === "collapsed" ? "expanded" : "collapsed"; return; }
    var chip = t.closest('[data-part="chip-remove"]');
    if (chip) { chip.parentElement.remove(); return; }
    var copy = t.closest('[data-ui="code-block"] [data-part="copy"]');
    if (copy && navigator.clipboard) { var code = copy.closest('[data-ui="code-block"]').querySelector('[data-part="code"]'); navigator.clipboard.writeText(code ? code.textContent : ""); return; }
    var jump = t.closest('[data-ui="message-scroller"] [data-part="jump"]');
    if (jump) { var vp = jump.parentElement.querySelector('[data-part="viewport"]'); vp.scrollTo({ top: vp.scrollHeight, behavior: "smooth" }); }
  });

  d.addEventListener("change", function (e) {
    var t = e.target;
    if (!t.closest) return;
    var cal = t.closest('[data-ui="calendar"]');
    if (cal && t.tagName === "SELECT") {
      var y = cal.querySelector('select[data-part="year"]'), m = cal.querySelector('select[data-part="month"]');
      cal.dataset.month = iso(+y.value, +m.value, 1).slice(0, 7);
      drawCalendar(cal);
      return;
    }
    var table = t.closest('[data-ui="data-table"]');
    if (table && t.type === "checkbox") {
      var rows = all(table, 'tbody input[type="checkbox"]');
      if (t.dataset.part === "select-all") rows.forEach(function (r) { r.checked = t.checked; });
      var n = rows.filter(function (r) { return r.checked; }).length;
      var head = table.querySelector('[data-part="select-all"]');
      if (head) { head.checked = n === rows.length; head.indeterminate = n > 0 && n < rows.length; }
      var c = table.querySelector('[data-part="count"]');
      if (c) c.textContent = n + " of " + rows.length + " row(s) selected.";
    }
  });

  d.addEventListener("input", function (e) {
    var t = e.target;
    if (!t.closest) return;
    if (t.matches('input[data-ui="slider"]')) { t.style.setProperty("--value", ((t.value - (t.min || 0)) / ((t.max || 100) - (t.min || 0))) * 100 + "%"); return; }
    if (t.matches('[data-ui="input-otp"] [data-part="slot"]') && t.value) { var s = all(t.closest('[data-ui="input-otp"]'), '[data-part="slot"]'); var x = s[s.indexOf(t) + 1]; if (x) x.focus(); return; }
    var cmd = t.closest('[data-ui="command"]');
    if (cmd && t.dataset.part === "input") {
      var q = t.value.toLowerCase(), any = false;
      all(cmd, '[data-part="group"]').forEach(function (g) {
        var hit = false;
        all(g, '[data-part="item"]').forEach(function (i) { var ok = i.textContent.toLowerCase().indexOf(q) >= 0; i.hidden = !ok; hit = hit || ok; });
        g.hidden = !hit; any = any || hit;
      });
      all(cmd, '[data-part="separator"]').forEach(function (s) { s.hidden = !!q; });
      var em = cmd.querySelector('[data-part="empty"]');
      if (em) em.hidden = any;
      return;
    }
    var combo = t.closest('[data-ui="combobox"]');
    if (combo && t.dataset.part === "control") {
      var content = combo.querySelector("[popover]");
      if (content && content.showPopover && !content.matches(":popover-open")) content.showPopover();
      var v = t.value.toLowerCase(), found = 0;
      all(combo, '[role="option"]').forEach(function (o) { var ok = o.textContent.toLowerCase().indexOf(v) >= 0; o.hidden = !ok; if (ok) found++; });
      if (content) content.dataset.empty = found ? "false" : "true";
    }
  });

  d.addEventListener("keydown", function (e) {
    var t = e.target;
    if (!t.closest) return;
    var tab = t.closest('[role="tab"]');
    if (tab) {
      var list = tabsOf(tab), i = list.indexOf(tab);
      var next = e.key === "ArrowRight" ? (i + 1) % list.length : e.key === "ArrowLeft" ? (i - 1 + list.length) % list.length : e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : -1;
      if (next >= 0 && list.length) { e.preventDefault(); pick(list, list[next], true); }
      return;
    }
    if (e.key === "Backspace" && t.matches('[data-ui="input-otp"] [data-part="slot"]') && !t.value) { var s = all(t.closest('[data-ui="input-otp"]'), '[data-part="slot"]'); var b = s[s.indexOf(t) - 1]; if (b) b.focus(); }
  });

  d.addEventListener("contextmenu", function (e) {
    var box = e.target.closest && e.target.closest('[data-ui="context-menu"] [data-part="trigger"]');
    if (!box) return;
    var menu = box.parentElement.querySelector("[popover]");
    if (!menu || !menu.showPopover) return;
    e.preventDefault();
    hide(menu);
    menu.style.left = e.clientX + "px"; menu.style.top = e.clientY + "px";
    menu.showPopover();
  });

  /* Moving across a menubar switches the open menu. */
  d.addEventListener("mouseover", function (e) {
    var t = e.target.closest && e.target.closest('[data-ui="menubar"] [data-part="trigger"]');
    if (!t) return;
    var bar = t.closest('[data-ui="menubar"]');
    var open = bar.querySelector('[data-part="content"]:popover-open');
    var mine = d.getElementById(t.getAttribute("popovertarget"));
    if (open && mine && open !== mine) { hide(open); mine.showPopover(); }
  });

  /* Resizable: dragging a handle shares space between its two panels. */
  d.addEventListener("pointerdown", function (e) {
    var h = e.target.closest && e.target.closest('[data-ui="resizable"] > [data-part="handle"]');
    if (!h) return;
    e.preventDefault();
    var box = h.parentElement, vert = box.dataset.direction === "vertical", a = h.previousElementSibling, b = h.nextElementSibling;
    var size = function (n) { var r = n.getBoundingClientRect(); return vert ? r.height : r.width; };
    var sum = size(a) + size(b), start = vert ? e.clientY : e.clientX, from = size(a);
    var move = function (m) {
      var at = Math.max(24, Math.min(sum - 24, from + (vert ? m.clientY : m.clientX) - start));
      a.style.flexGrow = at; b.style.flexGrow = sum - at;
    };
    var up = function () { d.removeEventListener("pointermove", move); d.removeEventListener("pointerup", up); };
    d.addEventListener("pointermove", move); d.addEventListener("pointerup", up);
  });

  /* A message scroller starts at the latest message; its jump button shows only when you've scrolled up. */
  function watchScroller(box) {
    var vp = box.querySelector('[data-part="viewport"]'), btn = box.querySelector('[data-part="jump"]');
    if (!vp) return;
    var sync = function () { if (btn) btn.setAttribute("data-active", vp.scrollHeight - vp.scrollTop - vp.clientHeight > 8 ? "true" : "false"); };
    vp.addEventListener("scroll", sync, { passive: true });
    vp.scrollTop = vp.scrollHeight;
    sync();
  }

  function init() {
    all(d, '[data-ui="calendar"]').forEach(drawCalendar);
    all(d, '[data-ui="message-scroller"]').forEach(watchScroller);
  }
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", init); else init();
})();
