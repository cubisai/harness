# Page theme format

A page theme is a named project copy of an **existing local Design theme** with token overrides. It is not CubiQ's window theme and does not style installed Apps. Apps use their normal Edit/Update flow.

Inspect installed first. `themes` lists local base IDs; `kit:foundation` is the default base. Call `creator_inspect` topic `theme-tokens`, name set to the base ID, to read its first 64 tokens. Do not write installed themes, `system/`, or `.agents/design-systems/` yourself.

Call `creator_propose` with `kind: "theme"`, `scope: "project"`, a lowercase dash name, and `config` as a JSON **string**:

```json
{"title":"Warm paper","description":"Quiet warm surfaces","base":"kit:foundation","tokens":[{"name":"--color-bg","scheme":"light","value":"#faf8f2"},{"name":"--color-bg","scheme":"dark","value":"#171612"}]}
```

- Only existing local kit/project base IDs. No downloads, source paths, new code or assets.
- 1–64 known token overrides, each a name, explicit `light`/`dark` scheme and value. Schemes are independent; preserve contrast in both. Unknown tokens, duplicates, cycles, URL-bearing values and CSS injection fail atomically.
- Config ≤32 KB; title ≤120 characters, description ≤500, values ≤200. No extra fields.
- Chats has no project folder: ask the user to open a project.
- Staging installs nothing and changes no design. Check both schemes with `creator_theme_preview` using its proposalId; the user also has an isolated preview on the card. If the inherited base changes, create a fresh proposal.
- Only the user clicks Install/Update. The theme then appears in Design → Style; **the user chooses when to apply it**. Same-name updates require a Creator-owned, unmodified theme. Uninstall removes only verified owned files, leaving active design copies intact.
