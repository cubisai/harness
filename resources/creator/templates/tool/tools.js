cubiq.onTool("add_item", async ({ title }) => {
  title = title.trim();
  if (!title || title.length > 160) throw new Error("Use a title of 1–160 characters.");
  const saved = await cubiq.store.get("items");
  const items = Array.isArray(saved) ? saved : [];
  if (items.length >= 100) throw new Error("The reading list holds at most 100 items.");
  items.push({ title });
  await cubiq.store.set("items", items);
  return { text: `Saved ${title} to your reading list.`, data: { count: items.length }, card: { name: "saved_item", data: { title, count: items.length } } };
});
