// A composer dock: one row, no connector. The focus line lives in cubiq.store; "Plan it" starts a chat the user sends.
const input = document.getElementById("focus");
const ask = document.getElementById("ask");

function show() {
  ask.hidden = !input.value.trim();
}

input.addEventListener("input", show);
input.addEventListener("change", () => {
  cubiq.store.set("focus", input.value.trim()).catch((err) => console.error("Couldn't save today's focus:", err));
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") input.blur();
});
ask.addEventListener("click", () => cubiq.ask(`Help me plan today's focus: ${input.value.trim()}`));

cubiq.store
  .get("focus")
  .then((saved) => {
    input.value = typeof saved === "string" ? saved : "";
    show();
  })
  .catch((err) => console.error("Couldn't read today's focus:", err));
