# Chat cards

A plugin tool can attach a small, read-only result frame to the transcript. Declare the local HTML entry in the same app.json:

```json
{
  "cards": [{ "name": "saved_item", "entry": "card.html", "height": 120 }]
}
```

Up to 8 cards; unique names follow tool-name rules. HTML must be in the plugin's files; `height` is 80–600 pixels (default 200). The width is the transcript's, so design for a narrow reading column. Never assume a fixed width.

The tool returns `card: { name: "saved_item", data: { title: "Paper", count: 3 } }`. Data is JSON, at most 64 KB, stored with the event so it survives reload. When card data is omitted, the tool's `data` is used, else null.

```js
cubiq.onCard((data) => {
  document.getElementById("title").textContent = data?.title ?? "No item";
  document.getElementById("count").textContent = String(data?.count ?? 0);
});
```

`onCard` returns an unsubscribe function and replays the data for a late listener. Treat strings as untrusted: use textContent, not innerHTML. Theme tokens and `cubiq.onTheme` work as usual. Each card is its own document: give it a descriptive `<title>` and an `<h1>` (compact styling is fine). Each card resolves only its declared local entry; never return HTML, a file path or URL from the tool. Reload reloads the **card**, never reruns the tool or model.

Cards cannot write the plugin store, mutate connector data, send notices, open plugins or start chats. Store reads and granted read-only connector calls are available in the originating thread's connector context, not whichever project is currently selected. Prefer the persisted result data over live calls, so old results stay understandable. Render empty, loading and error states.

Off/uninstall makes old cards unavailable; turning the plugin back on lets them render again. Updating uses the current declared card entry with the stored result data. Removing or renaming a card leaves a visible unavailable message and Retry.

Check a specimen before proposing:

```json
{ "name": "reading-list", "card": "saved_item", "cardData": "{\"title\":\"Paper\",\"count\":3}", "scheme": "dark" }
```

Pass this to `creator_app_check`, in both themes. It renders at 680 pixels wide and the declared height, never invokes the tool and refuses store/connector writes. Also check the real card at 900px with CubiQ's right panel open and keyboard focus on Reload.
