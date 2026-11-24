// A floating widget: no connector, state in cubiq.store, and a pill label while minimised.
const LENGTHS = { focus: 25 * 60, break: 5 * 60 };
const $ = (id) => document.getElementById(id);
let mode = "focus";
let left = LENGTHS.focus;
let endsAt = null; // epoch ms while running
let tick = null;

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

function render() {
  $("mode").textContent = mode === "focus" ? "Focus" : "Break";
  $("time").textContent = fmt(left);
  $("toggle").textContent = endsAt ? "Pause" : left < LENGTHS[mode] ? "Resume" : "Start";
  cubiq.pill(endsAt ? `${mode === "focus" ? "Focus" : "Break"} ${fmt(left)}` : "");
}

function save() {
  cubiq.store.set("timer", { mode, left, endsAt }).catch((err) => console.error("Couldn't save the timer:", err));
}

function step() {
  left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
  if (left === 0) {
    mode = mode === "focus" ? "break" : "focus";
    left = LENGTHS[mode];
    endsAt = Date.now() + left * 1000;
    save();
  }
  render();
}

function start() {
  endsAt = Date.now() + left * 1000;
  tick = setInterval(step, 1000);
  save();
  render();
}

function pause() {
  clearInterval(tick);
  tick = null;
  endsAt = null;
  save();
  render();
}

$("toggle").addEventListener("click", () => (endsAt ? pause() : start()));
$("reset").addEventListener("click", () => {
  pause();
  mode = "focus";
  left = LENGTHS.focus;
  save();
  render();
});

cubiq.store
  .get("timer")
  .then((saved) => {
    if (saved && (saved.mode === "focus" || saved.mode === "break")) {
      mode = saved.mode;
      left = Number.isFinite(saved.left) ? saved.left : LENGTHS[mode];
      if (saved.endsAt && saved.endsAt > Date.now()) {
        left = Math.round((saved.endsAt - Date.now()) / 1000);
        start();
        return;
      }
    }
    render();
  })
  .catch((err) => {
    console.error("Couldn't read the timer:", err);
    render();
  });
