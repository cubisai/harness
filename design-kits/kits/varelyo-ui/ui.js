/* varelyo/ui behaviour: tabs, dialogs and drawers, collapse toggles. Menus and popovers use the native popover API. */
(function () {
  "use strict";

  function onTabKey(list, event) {
    var tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]:not([disabled])'));
    var index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    var next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    tabs[next].focus();
    selectTab(tabs[next]);
  }

  function selectTab(tab) {
    var list = tab.closest('[role="tablist"]');
    if (!list) return;
    var tabs = list.querySelectorAll('[role="tab"]');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i] === tab;
      tabs[i].setAttribute("aria-selected", on ? "true" : "false");
      tabs[i].setAttribute("tabindex", on ? "0" : "-1");
      var panel = document.getElementById(tabs[i].getAttribute("aria-controls"));
      if (panel) {
        if (on) panel.removeAttribute("hidden");
        else panel.setAttribute("hidden", "");
      }
    }
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;

    var tab = target.closest('[role="tab"]');
    if (tab && tab.closest('[data-ui="tabs"]')) {
      selectTab(tab);
      return;
    }

    var opener = target.closest("[data-dialog-open]");
    if (opener) {
      var dialog = document.getElementById(opener.getAttribute("data-dialog-open"));
      if (dialog && dialog.tagName === "DIALOG" && !dialog.open) dialog.showModal();
      return;
    }

    var closer = target.closest("[data-dialog-close]");
    if (closer) {
      var owner = closer.closest("dialog");
      if (owner) owner.close();
      return;
    }

    if (target.tagName === "DIALOG" && target.matches('dialog[data-ui="dialog"], dialog[data-ui="drawer"]')) {
      // A click on the backdrop lands on the dialog itself, outside its panel.
      var box = target.getBoundingClientRect();
      var inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (!inside) target.close();
      return;
    }

    var toggle = target.closest('[aria-controls][aria-expanded]');
    if (toggle) {
      var region = document.getElementById(toggle.getAttribute("aria-controls"));
      if (region && region.matches('[data-ui="collapse"]')) {
        var open = toggle.getAttribute("aria-expanded") !== "true";
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        region.setAttribute("data-in", open ? "true" : "false");
      }
    }
  });

  document.addEventListener("keydown", function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var list = target.closest('[role="tablist"]');
    if (list) onTabKey(list, event);
  });
})();
