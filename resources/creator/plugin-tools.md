# Plugin tools

An app can give agents new abilities. Add `tools` to its app.json, keep the normal local UI `entry`, and optionally use a separate `toolEntry` HTML file for handlers. This is still `creator_propose kind: "app"`; one Install, Update, Off and Uninstall covers the UI and tools. Seed with `creator_app_preview template: "tool"`.

```json
{
  "toolEntry": "tools.html",
  "tools": [{
    "name": "add_item",
    "description": "Add an item to my reading list.",
    "inputSchema": {
      "type": "object",
      "properties": { "title": { "type": "string", "description": "The item's title" } },
      "required": ["title"],
      "additionalProperties": false
    }
  }]
}
```

- Up to 16 tools, names unique: lowercase letters, digits, underscores, start with a letter, at most 32 characters. Descriptions 1–500 characters. Agents usually see `plugin_<app_name>__<tool_name>`; app dashes become underscores. Long or ambiguous namespaces use a stable `plugin__<hash>` identifier so names remain unique and fit every engine. Discover the tool by its description rather than guessing its identifier.
- Input schema: root `object`; nested `object`, `array` (with `items`), `string` (optional string `enum`), `number`, `integer`, `boolean`. Optional descriptions; object `properties` and `required`. No open objects, refs, regex, unions, defaults or other constraints. At most four nested levels / 64 schema nodes. Field names start with a letter; letters/digits/underscores, up to 40. Reserved prototype keys are refused.
- Inputs are limited to 32 KB, arrays to 1000 items; outputs to 256 KB. Keep both much smaller.
- Register handlers when the page loads. **Do not call connectors or write the store on load**: the tool host refuses startup effects. If using the UI entry, keep UI startup logic out of the tool entry. The hidden frame is created only for an invocation and destroyed afterwards, so DOM state and timers are not persistent. Use `cubiq.store`.

```js
cubiq.onTool("add_item", async ({ title }) => {
  const items = (await cubiq.store.get("items")) ?? [];
  items.push({ title });
  await cubiq.store.set("items", items);
  return {
    text: `Added ${title}.`,
    data: { count: items.length },
    card: { name: "saved_item", data: { title, count: items.length } }
  };
});
```

Return `{ text: string, data?: JSON, card?: { name, data?: JSON } }`; throw an Error to fail. The card must be declared (see `chat-card`). No HTML or URL result surface. No Node, network, workers, popups or host DOM. Only the plugin's own store and its exact connector `grants`. At most 40 bridge calls per invocation, 30 seconds execution time; waiting for a connector/user is not counted. A hung renderer is stopped too. Tools are serialised to protect store read/modify/write sequences.

Tools are offered to **new Chat/Creator threads on Claude, Codex and ACP/OpenCode**, behind each engine's normal MCP discovery (not always-loaded). Installing never starts an agent turn. A thread keeps its tool descriptors: after changing tools, start a new thread. Off/uninstall/update cancels in-flight work and stale tool calls fail closed; stored plugin data survives Off/Update.

**Permission:** Ask/Auto-edit asks once before every tool invocation; Full access skips that outer question; Plan refuses tools. Connector writes still pass through the plugin's grants and AppCalls approvals; a new write approval is a separate single-use question in the thread, even in Full access. A user's existing “Always for this app” connector grant remains effective. Models, handlers and tool metadata cannot mark a write read-only or grant themselves access.

`creator_app_check` validates handler registration (including a separate `toolEntry`) **without invoking any tool**. Check actual behaviour with isolated fixtures or, after the user installs, an explicitly requested agent turn. Do not claim a passing render check proves the tool behaviour.
