/* Mantine kit behaviour. Tabs, dialogs, the searchable select, collapse, toggles, copy, password visibility, number steppers,
 * tags, multi-select, range and slider fills, and pin input focus. Menus, popovers, hover cards and tooltips need no script. */
(function () {
  "use strict";

  function selectTab(tab) {
    var list = tab.parentNode;
    var root = list.parentNode;
    var tabs = list.querySelectorAll('[role="tab"]');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i] === tab;
      tabs[i].setAttribute("aria-selected", on ? "true" : "false");
      tabs[i].setAttribute("tabindex", on ? "0" : "-1");
      var panel = document.getElementById(tabs[i].getAttribute("aria-controls"));
      if (panel && panel.parentNode === root) {
        if (on) panel.removeAttribute("hidden");
        else panel.setAttribute("hidden", "");
      }
    }
    tab.focus();
  }

  function filterSelect(select, query) {
    var options = select.querySelectorAll('[data-part="option"]');
    var shown = 0;
    var q = query.trim().toLowerCase();
    for (var i = 0; i < options.length; i++) {
      var match = q === "" || options[i].textContent.toLowerCase().indexOf(q) !== -1;
      options[i].hidden = !match;
      if (match) shown++;
    }
    var empty = select.querySelector('[data-part="empty"]');
    if (empty) empty.hidden = shown > 0;
    return shown;
  }

  function openSelect(input) {
    var select = input.closest('[data-ui="select"]');
    var list = select.querySelector('[data-part="dropdown"]');
    if (list && !list.matches(":popover-open")) list.showPopover();
    input.setAttribute("aria-expanded", "true");
  }

  function closeSelect(select) {
    var input = select.querySelector('[data-part="input"]');
    var list = select.querySelector('[data-part="dropdown"]');
    if (list && list.matches(":popover-open")) list.hidePopover();
    if (input) input.setAttribute("aria-expanded", "false");
  }

  function pickOption(option) {
    var select = option.closest('[data-ui="select"]');
    var options = select.querySelectorAll('[data-part="option"]');
    for (var i = 0; i < options.length; i++) {
      options[i].setAttribute("aria-selected", options[i] === option ? "true" : "false");
    }
    var input = select.querySelector('[data-part="input"]');
    if (input) input.value = option.textContent;
    closeSelect(select);
    filterSelect(select, "");
  }

  function addPill(root, text, removeLabel) {
    var pill = document.createElement("span");
    pill.setAttribute("data-ui", "pill");
    pill.setAttribute("data-size", "sm");
    pill.appendChild(document.createTextNode(text));
    var remove = document.createElement("button");
    remove.setAttribute("data-part", "remove");
    remove.setAttribute("type", "button");
    remove.setAttribute("aria-label", "Remove " + text);
    var icon = document.createElement("i");
    icon.setAttribute("data-ui", "icon");
    icon.setAttribute("data-name", "x");
    remove.appendChild(icon);
    pill.appendChild(remove);
    root.appendChild(pill);
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;

    var tab = target.closest('[data-ui="tabs"] [role="tab"]');
    if (tab) {
      selectTab(tab);
      return;
    }

    var opener = target.closest("[data-dialog-open]");
    if (opener) {
      var dialog = document.getElementById(opener.getAttribute("data-dialog-open"));
      if (dialog && typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
      return;
    }

    var closer = target.closest("[data-dialog-close]");
    if (closer) {
      var owner = closer.closest("dialog");
      if (owner && owner.open) owner.close();
      return;
    }

    if (target.tagName === "DIALOG" && target.matches("dialog[data-ui]") && target.open) {
      target.close();
      return;
    }

    var option = target.closest('[data-ui="select"] [data-part="option"]');
    if (option) {
      pickOption(option);
      return;
    }

    var toggleCollapse = target.closest("[data-collapse-toggle]");
    if (toggleCollapse) {
      var panel = document.getElementById(toggleCollapse.getAttribute("data-collapse-toggle"));
      if (panel) {
        var nowHidden = !panel.hidden;
        panel.hidden = nowHidden;
        toggleCollapse.setAttribute("aria-expanded", nowHidden ? "false" : "true");
      }
      return;
    }

    var toggle = target.closest('[data-ui="toggle"]');
    if (toggle) {
      toggle.setAttribute("aria-pressed", toggle.getAttribute("aria-pressed") === "true" ? "false" : "true");
      return;
    }

    var copy = target.closest('[data-ui="copy-button"]');
    if (copy) {
      var text = copy.textContent.trim();
      if (navigator.clipboard) navigator.clipboard.writeText(text).catch(function () {});
      copy.setAttribute("data-copied", "true");
      return;
    }

    var reveal = target.closest('[data-ui="password-input"] [data-part="toggle"]');
    if (reveal) {
      var pw = reveal.parentNode.querySelector('[data-part="input"]');
      var shown = pw.type === "text";
      pw.type = shown ? "password" : "text";
      reveal.setAttribute("aria-label", shown ? "Show password" : "Hide password");
      return;
    }

    var stepper = target.closest('[data-ui="number-input"] [data-part="stepper"]');
    if (stepper) {
      var field = stepper.closest('[data-ui="number-input"]').querySelector('[data-part="input"]');
      var n = parseInt(field.value, 10);
      if (isNaN(n)) n = 0;
      field.value = String(stepper.getAttribute("data-dir") === "up" ? n + 1 : n - 1);
      return;
    }

    var pillRemove = target.closest('[data-ui="tags-input"] [data-part="remove"], [data-ui="multi-select"] [data-part="control"] [data-part="remove"]');
    if (pillRemove) {
      var pill = pillRemove.closest('[data-ui="pill"]');
      if (pill) pill.parentNode.removeChild(pill);
      return;
    }

    var mOption = target.closest('[data-ui="multi-select"] [data-part="suggestions"] [data-part="option"]');
    if (mOption) {
      var field2 = mOption.closest('[data-ui="multi-select"]');
      var on = mOption.getAttribute("aria-selected") !== "true";
      mOption.setAttribute("aria-selected", on ? "true" : "false");
      var control = field2.querySelector('[data-part="control"]');
      var label = mOption.textContent.trim();
      var existing = null;
      var pills = control.querySelectorAll('[data-ui="pill"]');
      for (var p = 0; p < pills.length; p++) if (pills[p].firstChild.textContent === label) existing = pills[p];
      if (on && !existing) addPill(control, label);
      if (!on && existing) existing.parentNode.removeChild(existing);
    }
  });

  document.addEventListener("input", function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;

    if (target.matches('[data-ui="select"] [data-part="input"]')) {
      var select = target.closest('[data-ui="select"]');
      openSelect(target);
      filterSelect(select, target.value);
      return;
    }

    if (target.matches('input[data-ui="slider"]')) {
      var pct = ((target.value - target.min) / (target.max - target.min)) * 100;
      target.style.setProperty("--p", pct + "%");
      return;
    }

    if (target.matches('[data-ui="range-slider"] [data-part="input"]')) {
      var root = target.closest('[data-ui="range-slider"]');
      var inputs = root.querySelectorAll('[data-part="input"]');
      var lo = parseFloat(inputs[0].value), hi = parseFloat(inputs[1].value);
      if (lo > hi) {
        var swap = lo; lo = hi; hi = swap;
      }
      root.style.setProperty("--lo", lo + "%");
      root.style.setProperty("--hi", hi + "%");
      return;
    }

    if (target.matches('[data-ui="pin-input"] [data-part="input"]') && target.value) {
      var next = target.nextElementSibling;
      if (next && next.matches('[data-part="input"]')) next.focus();
    }
  });

  document.addEventListener("focusin", function (event) {
    var target = event.target;
    if (target instanceof Element && target.matches('[data-ui="select"] [data-part="input"]')) openSelect(target);
  });

  document.addEventListener("focusout", function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var select = target.closest && target.closest('[data-ui="select"]');
    if (select && target.matches('[data-part="input"]')) {
      setTimeout(function () {
        if (!select.contains(document.activeElement)) closeSelect(select);
      }, 150);
    }
  });

  document.addEventListener("keydown", function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;

    if (target.matches('[data-ui="select"] [data-part="input"]')) {
      if (event.key === "Escape") closeSelect(target.closest('[data-ui="select"]'));
      if (event.key === "Enter") {
        var first = target.closest('[data-ui="select"]').querySelector('[data-part="option"]:not([hidden])');
        if (first) pickOption(first);
        event.preventDefault();
      }
      return;
    }

    if (target.matches('[data-ui="tags-input"] [data-part="input"]') && event.key === "Enter" && target.value.trim()) {
      addPill(target.parentNode, target.value.trim());
      target.value = "";
      event.preventDefault();
      return;
    }

    var tab = target.closest('[data-ui="tabs"] [role="tab"]');
    if (!tab || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
    var tabs = Array.prototype.slice.call(tab.parentNode.querySelectorAll('[role="tab"]'));
    var index = tabs.indexOf(tab);
    var next2 = event.key === "ArrowRight" ? (index + 1) % tabs.length : (index - 1 + tabs.length) % tabs.length;
    event.preventDefault();
    selectTab(tabs[next2]);
  });
  /* The design canvas puts new parts in without reloading; nothing here draws at load, so there is nothing to redo. */
  document.addEventListener("kit:refresh", function (e) { e.preventDefault(); });
})();
