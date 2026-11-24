# CubiQ app themes

Recolor CubiQ itself with an `app` plugin, **not** the project-only `theme` proposal kind. Read `creator_inspect` topic `app-theme-tokens` for current defaults and supported names.

Add `contributes.appTheme` to draft `app.json`: optional `light` and `dark` token maps. At least one override, one theme per plugin (one of 64 parts), up to 15 tokens per scheme, 16 KB total. Keys have no leading `--`.

Supported: bg, bg-sidebar, bg-elevated, bg-subtle, bg-chip, bg-hover, bg-selected, text, text-secondary, text-tertiary, hairline, hairline-strong, primary, on-primary, focus.

Values: **opaque 3/6-digit hex only**. No CSS, alpha, transparent, named colors, functions, references, URLs, layout, fonts, shadows or animation. Signal, danger/warning/success, syntax, file badges and canvas selection stay host-controlled. Related primary/Send/goo color companions are derived by CubiQ. Unspecified roles keep the exact defaults for their scheme.

Both effective palettes are checked for contrast, including fixed semantic/syntax colors on changed backgrounds. Errors identify pairs. Body/button labels need 4.5:1, focus 3:1; existing below-target baseline pairs must not regress. Tinted surfaces may require stronger secondary/metadata text; never hide warnings or approvals.

`creator_app_preview` template `app-theme` is a valid starting plugin. Edit its manifest, check light/dark, propose kind `app`, scope `global`. Check additionally renders a fixed isolated palette specimen; it does not prove live host UI coverage and never selects the palette.

Only the **user** previews live chrome from review/Plugins/Appearance. Preview is temporary, with Cancel/Escape, ending when its source closes/changes. Review and Install precede Apply. **Install, Open and On do not apply.** One selected theme, no stacking; Apply preserves Light/Dark/System, zoom and motion. Revert to CubiQ affects appearance only.

Off/Uninstall resets selection; On does not reapply. Changed/removed theme Update needs fresh Apply; unchanged content preserves selection. Failed operations keep the old valid selection. Restart restores only an explicit still-valid selection.

No theme-writing bridge API. Do not modify installed files, Settings or host token sources yourself. Design page themes remain separate.
