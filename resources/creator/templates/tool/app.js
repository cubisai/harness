const status = document.getElementById("status");
const list = document.getElementById("items");
const button = document.getElementById("refresh");
async function load() {
  button.disabled = true; status.textContent = "Loading…";
  try {
    const saved = await cubiq.store.get("items");
    const items = Array.isArray(saved) ? saved : [];
    list.replaceChildren();
    for (const item of items) { const li = document.createElement("li"); li.textContent = String(item.title ?? "Untitled"); list.append(li); }
    status.textContent = items.length ? `${items.length} saved item${items.length === 1 ? "" : "s"}.` : "Nothing saved yet. Ask your agent to add a title.";
  } catch (err) { status.textContent = `Couldn't load the list: ${err.message}. Use Refresh to retry.`; console.error(err); }
  finally { button.disabled = false; }
}
button.addEventListener("click", load);
load();
