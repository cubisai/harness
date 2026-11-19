// A page: fills CubiQ's main area. No connector; the list lives in cubiq.store.
const $ = (id) => document.getElementById(id);
let items = [];
let failed = false;

function save() {
  cubiq.store.set("items", items).catch((err) => {
    console.error("Couldn't save the list:", err);
    cubiq.notify("Couldn't save the reading list.");
  });
}

function render() {
  const list = $("list");
  list.replaceChildren();
  $("count").textContent = String(items.filter((i) => !i.done).length);
  if (failed) {
    const p = document.createElement("p");
    p.className = "error";
    p.textContent = "Couldn't load the list. Reload to try again.";
    list.append(p);
    return;
  }
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Nothing to read yet. Add something above.";
    list.append(p);
    return;
  }
  const ul = document.createElement("ul");
  for (const item of items) {
    const li = document.createElement("li");
    if (item.done) li.className = "done";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = item.done;
    box.setAttribute("aria-label", `Read: ${item.title}`);
    box.addEventListener("change", () => {
      item.done = box.checked;
      save();
      render();
    });
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = item.title;
    if (item.note) {
      const note = document.createElement("span");
      note.className = "note";
      note.textContent = item.note;
      text.append(note);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${item.title}`);
    remove.addEventListener("click", () => {
      items = items.filter((i) => i !== item);
      save();
      render();
    });
    li.append(box, text, remove);
    ul.append(li);
  }
  list.append(ul);
}

function add() {
  const title = $("title").value.trim();
  if (!title) return;
  items.unshift({ title, note: $("note").value.trim(), done: false });
  $("title").value = "";
  $("note").value = "";
  save();
  render();
  $("title").focus();
}

$("add").addEventListener("click", add);
for (const id of ["title", "note"]) {
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") add();
  });
}

cubiq.store
  .get("items")
  .then((saved) => {
    items = Array.isArray(saved) ? saved.filter((i) => i && typeof i.title === "string") : [];
    render();
  })
  .catch((err) => {
    console.error("Couldn't read the list:", err);
    failed = true;
    render();
  });
