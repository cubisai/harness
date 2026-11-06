/* Foundation: behaviour for tabs and dialog. Safe to load on pages without either part. */
(function () {
  "use strict";

  function all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function tabsIn(el) {
    var box = el.closest('[data-ui="tabs"]');
    return box ? all('[role="tab"]', box) : [];
  }

  function select(box, tab, focus) {
    var panel = document.getElementById(tab.getAttribute("aria-controls"));
    all('[role="tab"]', box).forEach(function (t) {
      var on = t === tab;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.setAttribute("tabindex", on ? "0" : "-1");
      var p = document.getElementById(t.getAttribute("aria-controls"));
      if (p) p.hidden = !on;
    });
    if (panel && focus !== false) panel.focus();
    if (focus === true) tab.focus();
  }

  document.addEventListener("click", function (e) {
    var tab = e.target.closest && e.target.closest('[role="tab"]');
    if (tab) {
      e.preventDefault();
      select(tab.closest('[data-ui="tabs"]'), tab, true);
      return;
    }
    var open = e.target.closest && e.target.closest("[data-dialog-open]");
    if (open) {
      var dlg = document.getElementById(open.getAttribute("data-dialog-open"));
      if (dlg && dlg.showModal) {
        e.preventDefault();
        dlg.showModal();
      }
      return;
    }
    var close = e.target.closest && e.target.closest("[data-dialog-close]");
    if (close) {
      var near = close.closest("dialog");
      if (near && near.close) near.close();
    }
  });

  document.addEventListener("keydown", function (e) {
    var tab = e.target.closest && e.target.closest('[role="tab"]');
    if (!tab) return;
    var list = tabsIn(tab);
    var i = list.indexOf(tab);
    var next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % list.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    if (next < 0) return;
    e.preventDefault();
    select(tab.closest('[data-ui="tabs"]'), list[next], true);
  });
  /* The design canvas puts new parts in without reloading; nothing here draws at load, so there is nothing to redo. */
  document.addEventListener("kit:refresh", function (e) { e.preventDefault(); });
})();
