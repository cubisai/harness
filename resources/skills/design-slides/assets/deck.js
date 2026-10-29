// A tiny slide runtime: one <section class="slide"> per slide, each 1920x1080, scaled to fit.
// Keys: right/space/PageDown next, left/PageUp back, Home/End, O overview. #3 opens slide 3. Print = one slide per page.
(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll("section.slide"));
  if (!slides.length) return;
  var deck = document.querySelector(".deck") || document.body;
  var counter = document.createElement("div");
  counter.className = "deck-counter";
  counter.setAttribute("aria-live", "polite");
  document.body.appendChild(counter);
  var current = 0;
  var overview = false;

  function fromHash() {
    var n = parseInt((location.hash || "").slice(1), 10);
    return n >= 1 && n <= slides.length ? n - 1 : 0;
  }

  function fit() {
    var scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    document.documentElement.style.setProperty("--deck-scale", String(scale));
  }

  function show(i) {
    current = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach(function (s, k) {
      s.classList.toggle("is-active", k === current);
      s.setAttribute("aria-hidden", overview || k === current ? "false" : "true");
    });
    counter.textContent = current + 1 + " / " + slides.length;
    try {
      if (location.hash !== "#" + (current + 1)) location.hash = String(current + 1);
    } catch (e) {
      // A sandboxed frame may refuse; the slide still changes.
    }
  }

  function toggleOverview() {
    overview = !overview;
    deck.classList.toggle("is-overview", overview);
    show(current);
  }

  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    var k = e.key;
    if (k === "ArrowRight" || k === "PageDown" || (k === " " && !e.shiftKey)) show(current + 1);
    else if (k === "ArrowLeft" || k === "PageUp" || (k === " " && e.shiftKey)) show(current - 1);
    else if (k === "Home") show(0);
    else if (k === "End") show(slides.length - 1);
    else if (k === "o" || k === "O") toggleOverview();
    else return;
    e.preventDefault();
  });

  slides.forEach(function (s, k) {
    s.addEventListener("click", function () {
      if (overview) {
        toggleOverview();
        show(k);
      }
    });
  });

  window.addEventListener("hashchange", function () {
    if (fromHash() !== current) show(fromHash());
  });
  window.addEventListener("resize", fit);
  fit();
  show(fromHash());
})();
