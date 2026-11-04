/* Chakra UI kit behaviour. Plain script, no dependencies. Loaded after the page, it wires:
 * tabs (click and arrow keys), dialogs and drawers (data-dialog-open, data-dialog-close, backdrop click),
 * the calendar (drawn from data-month and data-selected), carousel, number input steppers, password reveal,
 * pin input auto-advance, tags input, toast dismissal, tree view expansion, select and combobox filtering,
 * command search, rating and editable text. Native controls (popover, details, radio, checkbox) need no script. */
(function () {
  "use strict";

  function on(root, type, selector, handler) {
    root.addEventListener(type, function (event) {
      var target = event.target.closest ? event.target.closest(selector) : null;
      if (target && root.contains(target)) handler(event, target);
    });
  }

  /* Tabs: one selected tab, its panel shown, arrow keys move between tabs. */
  function selectTab(tab) {
    var list = tab.parentElement;
    list.querySelectorAll('[role="tab"]').forEach(function (t) {
      var on = t === tab;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      var panel = document.getElementById(t.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    });
    tab.focus();
  }
  document.querySelectorAll('[data-ui="tabs"] [role="tablist"]').forEach(function (list) {
    on(list, "click", '[role="tab"]', function (e, tab) { selectTab(tab); });
    list.addEventListener("keydown", function (e) {
      var tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
      var i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      var next = null;
      if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
      if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
      if (e.key === "Home") next = tabs[0];
      if (e.key === "End") next = tabs[tabs.length - 1];
      if (next) { e.preventDefault(); selectTab(next); }
    });
  });

  /* Dialogs and drawers: open with showModal, close from any data-dialog-close, or a click on the backdrop. */
  document.addEventListener("click", function (e) {
    var opener = e.target.closest("[data-dialog-open]");
    if (opener) {
      var dialog = document.getElementById(opener.getAttribute("data-dialog-open"));
      if (dialog && dialog.showModal && !dialog.open) dialog.showModal();
      return;
    }
    var closer = e.target.closest("[data-dialog-close]");
    if (closer) {
      var owner = closer.closest("dialog");
      if (owner) owner.close();
      return;
    }
    if (e.target.matches && e.target.matches('dialog[data-ui="dialog"], dialog[data-ui="drawer"]')) {
      var box = e.target.getBoundingClientRect();
      var inside = e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
      if (!inside) e.target.close();
    }
  });

  /* Calendar: draws a month from data-month (YYYY-MM) and marks data-selected (YYYY-MM-DD). */
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function drawCalendar(el) {
    var month = el.getAttribute("data-month") || "";
    var selected = el.getAttribute("data-selected") || "";
    var y = parseInt(month.slice(0, 4), 10), m = parseInt(month.slice(5, 7), 10) - 1;
    if (isNaN(y) || isNaN(m)) { var now = new Date(); y = now.getFullYear(); m = now.getMonth(); }
    el.setAttribute("data-month", y + "-" + pad(m + 1));
    el.setAttribute("role", "application");
    el.setAttribute("aria-label", "Calendar");
    var first = new Date(y, m, 1);
    var offset = (first.getDay() + 6) % 7;
    var start = new Date(y, m, 1 - offset);
    var today = new Date();
    var html = '<div data-part="head"><div data-part="title" aria-live="polite">' + MONTHS[m] + " " + y + '</div><div data-part="nav">' +
      '<button type="button" data-step="-1" aria-label="Previous month">&#8249;</button>' +
      '<button type="button" data-step="1" aria-label="Next month">&#8250;</button></div></div>' +
      '<div data-part="grid" role="grid">';
    DAYS.forEach(function (d) { html += '<div data-part="weekday" role="columnheader">' + d + "</div>"; });
    for (var k = 0; k < 42; k++) {
      var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + k);
      var key = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
      var attrs = ' data-part="day" data-date="' + key + '"';
      if (d.getMonth() !== m) attrs += ' data-outside="true"';
      if (d.toDateString() === today.toDateString()) attrs += ' data-today="true"';
      attrs += key === selected ? ' aria-selected="true"' : ' aria-selected="false"';
      html += '<button type="button"' + attrs + ">" + d.getDate() + "</button>";
    }
    el.innerHTML = html + "</div>";
  }
  function stepCalendar(el, step) {
    var parts = (el.getAttribute("data-month") || "").split("-");
    var d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1 + step, 1);
    el.setAttribute("data-month", d.getFullYear() + "-" + pad(d.getMonth() + 1));
    drawCalendar(el);
  }
  document.querySelectorAll('[data-ui="calendar"]').forEach(drawCalendar);
  document.addEventListener("click", function (e) {
    var step = e.target.closest("[data-step]");
    if (step) { var cal = step.closest('[data-ui="calendar"]'); if (cal) stepCalendar(cal, parseInt(step.getAttribute("data-step"), 10)); return; }
    var day = e.target.closest('[data-ui="calendar"] [data-part="day"]');
    if (day) {
      var owner = day.closest('[data-ui="calendar"]');
      owner.setAttribute("data-selected", day.getAttribute("data-date"));
      owner.querySelectorAll('[data-part="day"]').forEach(function (b) { b.setAttribute("aria-selected", b === day ? "true" : "false"); });
      var field = owner.closest('[data-ui="date-picker"]');
      var input = field && field.querySelector("input");
      if (input) input.value = day.getAttribute("data-date");
    }
  });

  /* Carousel: previous and next move the viewport one slide, the dots follow. */
  document.querySelectorAll('[data-ui="carousel"]').forEach(function (car) {
    var view = car.querySelector('[data-part="viewport"]');
    var slides = car.querySelectorAll('[data-part="slide"]');
    var dots = car.querySelectorAll('[data-part="dot"]');
    function go(i) {
      i = Math.max(0, Math.min(slides.length - 1, i));
      if (view && slides[i]) view.scrollTo({ left: slides[i].offsetLeft - view.offsetLeft, behavior: "smooth" });
      dots.forEach(function (d, j) { if (j === i) d.setAttribute("data-current", "true"); else d.removeAttribute("data-current"); });
      car.setAttribute("data-slide", String(i));
    }
    var prev = car.querySelector('[data-part="prev"]'), next = car.querySelector('[data-part="next"]');
    if (prev) prev.addEventListener("click", function () { go(parseInt(car.getAttribute("data-slide") || "0", 10) - 1); });
    if (next) next.addEventListener("click", function () { go(parseInt(car.getAttribute("data-slide") || "0", 10) + 1); });
    dots.forEach(function (d, j) { d.addEventListener("click", function () { go(j); }); });
  });

  /* Number input: the steppers change the value by the step, within min and max. */
  document.addEventListener("click", function (e) {
    var btn = e.target.closest('[data-ui="number-input"] [data-part="inc"], [data-ui="number-input"] [data-part="dec"]');
    if (!btn) return;
    var input = btn.closest('[data-ui="number-input"]').querySelector('[data-part="input"]');
    var step = parseFloat(input.getAttribute("step") || "1");
    var value = parseFloat(input.value || "0");
    var min = input.hasAttribute("min") ? parseFloat(input.getAttribute("min")) : -Infinity;
    var max = input.hasAttribute("max") ? parseFloat(input.getAttribute("max")) : Infinity;
    var next = btn.getAttribute("data-part") === "inc" ? value + step : value - step;
    input.value = String(Math.max(min, Math.min(max, next)));
  });

  /* Password input: the toggle shows and hides the characters. */
  document.addEventListener("click", function (e) {
    var toggle = e.target.closest('[data-ui="password-input"] [data-part="toggle"]');
    if (!toggle) return;
    var input = toggle.closest('[data-ui="password-input"]').querySelector("input");
    var shown = input.type === "text";
    input.type = shown ? "password" : "text";
    toggle.setAttribute("aria-label", shown ? "Show password" : "Hide password");
  });

  /* Pin input: typing moves to the next box, backspace to the previous one. */
  document.querySelectorAll('[data-ui="pin-input"]').forEach(function (group) {
    var boxes = group.querySelectorAll('[data-part="pin"]');
    boxes.forEach(function (box, i) {
      box.addEventListener("input", function () { if (box.value && boxes[i + 1]) boxes[i + 1].focus(); });
      box.addEventListener("keydown", function (e) { if (e.key === "Backspace" && !box.value && boxes[i - 1]) boxes[i - 1].focus(); });
    });
  });

  /* Tags input: Enter turns the typed text into a tag; a tag's close button removes it. */
  document.querySelectorAll('[data-ui="tags-input"]').forEach(function (field) {
    var input = field.querySelector('[data-part="input"]');
    input.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" || !input.value.trim()) return;
      e.preventDefault();
      var tag = document.createElement("span");
      tag.setAttribute("data-ui", "tag");
      tag.setAttribute("data-size", field.getAttribute("data-size") || "md");
      tag.innerHTML = '<span data-part="label"></span><button data-ui="close-button" data-size="2xs" type="button" aria-label="Remove"><i data-ui="icon" data-name="x"></i></button>';
      tag.querySelector('[data-part="label"]').textContent = input.value.trim();
      field.insertBefore(tag, input);
      input.value = "";
    });
  });
  document.addEventListener("click", function (e) {
    var remove = e.target.closest('[data-ui="tag"] [data-ui="close-button"]');
    if (remove) remove.closest('[data-ui="tag"]').remove();
    var dismiss = e.target.closest('[data-ui="toast"] [data-part="close"]');
    if (dismiss) dismiss.closest('[data-ui="toast"]').remove();
  });

  /* Select: picking an option fills the trigger, marks it selected and closes the popover. */
  document.addEventListener("click", function (e) {
    var option = e.target.closest('[data-ui="select"] [data-part="item"]');
    if (!option) return;
    var root = option.closest('[data-ui="select"]');
    root.querySelectorAll('[data-part="item"]').forEach(function (o) { o.setAttribute("aria-selected", o === option ? "true" : "false"); });
    var value = root.querySelector('[data-part="value"]');
    if (value) value.textContent = option.textContent.trim();
    var content = option.closest('[data-part="content"]');
    if (content && content.hidePopover) content.hidePopover();
  });

  /* Combobox and command: typing filters the items by their text. */
  function filter(input, items) {
    var q = input.value.trim().toLowerCase();
    items.forEach(function (item) {
      var hit = item.textContent.toLowerCase().indexOf(q) !== -1;
      item.hidden = !hit;
    });
  }
  document.querySelectorAll('[data-ui="combobox"]').forEach(function (box) {
    var input = box.querySelector('[data-part="input"]');
    input.addEventListener("input", function () { filter(input, box.querySelectorAll('[data-part="item"]')); });
  });
  document.querySelectorAll('[data-ui="command"]').forEach(function (box) {
    var input = box.querySelector('[data-part="input"]');
    input.addEventListener("input", function () { filter(input, box.querySelectorAll('[data-part="item"]')); });
  });

  /* Tree view: a click on a row toggles its branch. */
  document.addEventListener("click", function (e) {
    var row = e.target.closest('[data-ui="tree-view"] [data-part="item"][aria-expanded] > [data-part="content"]');
    if (row) {
      var item = row.parentElement;
      item.setAttribute("aria-expanded", item.getAttribute("aria-expanded") === "true" ? "false" : "true");
    }
  });

  /* Rating: a click on a star fills it and the stars before it. */
  document.addEventListener("click", function (e) {
    var star = e.target.closest('[data-ui="rating"] [data-part="star"]');
    if (!star) return;
    var stars = Array.prototype.slice.call(star.parentElement.querySelectorAll('[data-part="star"]'));
    var upTo = stars.indexOf(star);
    stars.forEach(function (s, i) { s.setAttribute("data-filled", i <= upTo ? "true" : "false"); });
  });

  /* Editable text: Enter commits, Escape reverts to the text it had when focused. */
  document.querySelectorAll('[data-ui="editable"] [data-part="preview"]').forEach(function (el) {
    var original = "";
    el.addEventListener("focus", function () { original = el.textContent; });
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); el.blur(); }
      if (e.key === "Escape") { el.textContent = original; el.blur(); }
    });
  });
})();
