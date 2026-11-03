/* shadcn/ui kit: tabs and native dialogs. Popovers, accordions and tooltips need no script. Safe on any page. */
(function () {
  "use strict";

  function pick(list, tab, focus) {
    list.forEach(function (t) {
      var on = t === tab;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.setAttribute("tabindex", on ? "0" : "-1");
      var panel = document.getElementById(t.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    });
    if (focus) tab.focus();
  }

  function tabsOf(tab) {
    var box = tab.closest('[data-ui="tabs"]');
    return box ? Array.prototype.slice.call(box.querySelectorAll('[role="tab"]')) : [];
  }

  document.addEventListener("click", function (e) {
    var el = e.target;
    if (!el.closest) return;
    var tab = el.closest('[role="tab"]');
    if (tab && tabsOf(tab).length) {
      e.preventDefault();
      pick(tabsOf(tab), tab, true);
      return;
    }
    var open = el.closest("[data-dialog-open]");
    if (open) {
      var dlg = document.getElementById(open.getAttribute("data-dialog-open"));
      if (dlg && dlg.showModal && !dlg.open) {
        e.preventDefault();
        dlg.showModal();
      }
      return;
    }
    var close = el.closest("[data-dialog-close]");
    if (close) {
      var near = close.closest("dialog");
      if (near) near.close();
      return;
    }
    // A click on the dialog element itself landed on its backdrop. An alert dialog has to be answered.
    if (el.tagName === "DIALOG" && el.open && el.getAttribute("data-ui") !== "alert-dialog") {
      var r = el.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) el.close();
    }
  });

  document.addEventListener("keydown", function (e) {
    var tab = e.target.closest && e.target.closest('[role="tab"]');
    if (!tab) return;
    var list = tabsOf(tab);
    var i = list.indexOf(tab);
    var next = e.key === "ArrowRight" ? (i + 1) % list.length
      : e.key === "ArrowLeft" ? (i - 1 + list.length) % list.length
      : e.key === "Home" ? 0
      : e.key === "End" ? list.length - 1 : -1;
    if (next < 0 || !list.length) return;
    e.preventDefault();
    pick(list, list[next], true);
  });
})();
