# App bridge: `window.cubiq`

Injected into every app page before your scripts run. It is the app's only way out of its frame.

## Calls

```js
const data = await cubiq.call("shop", "sales_summary", { days: 30 });
```

- Resolves to the tool's structured data when it returns some, else its text (parsed when it is JSON). Rejects with an `Error` whose message says why (not granted, bad arguments, the server failed, the user declined).
- Only tools listed in app.json `grants` work. Arguments are checked against the tool's input schema.
- Tools the server marks read-only run at once. Any other tool asks the user in the app's window on every call (Deny / Allow once / Always for this app); the promise waits for that answer. Never call a data-changing tool on load: only from a clear user action (a button), and say what it will do.
- Results are capped at 256 KB: ask for less (a date range, a limit, a page) when a call may be large.
- Secrets never reach the app: the connector's credentials stay in CubiQ.

## Store

```js
await cubiq.store.set("range", 30);       // any JSON value; null deletes
const range = (await cubiq.store.get("range")) ?? 7;
```

Per app, up to 1 MB in all. Use it for the user's choices (filters, tabs), not for caching connector data.

## Theme

```js
cubiq.theme();                  // "light" | "dark"
cubiq.onTheme((scheme) => {});  // returns an unsubscribe function
```

The `--cq-*` CSS variables update by themselves; listen only when you draw with canvas.

## Pill (floating widgets)

```js
cubiq.pill("Focus 12:30");  // the label while the widget is minimised; "" shows the title
```

Up to 40 characters. Update it when the state the user glances at changes (a countdown, a count), not on every frame.

## Notify, open another plugin, ask

```js
cubiq.notify("Saved 3 items");          // a short toast headed with your app's title (200 chars)
cubiq.openPlugin("reading-list");       // open another installed, enabled plugin by its name
cubiq.ask("Summarise these notes: …");  // a new chat with this text in the composer; the user reads and sends it
```

- All three return nothing. Call them from a clear user action, not on load or in a loop: extra calls within a few seconds are dropped.
- `ask` never sends anything by itself. In a Creator preview it only shows what it would do, so the thread you're in stays open.

## Errors

Agent tool handlers use `cubiq.onTool(name, fn)`; transcript frames use `cubiq.onCard(fn)`. Read the `plugin-tools` and `chat-card` references before using them. Only the hidden tool host invokes handlers; cards receive persisted JSON and cannot change data.

Uncaught errors, rejected promises, `console.error` and `console.warn` are reported to the app's window (its error count) and to `creator_app_check`. Don't swallow errors silently: show them in the page and log them.

## Not available

No network (`fetch`, XHR, WebSocket, remote images or fonts), no parent window or CubiQ DOM, no Node, no popups, no forms that submit, no cookies or `localStorage` (the frame has an opaque origin: use `cubiq.store`).
