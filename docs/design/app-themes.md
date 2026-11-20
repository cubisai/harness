# Authored app palettes

App themes are reviewed `app.json.contributes.appTheme` data, not CSS or Design page themes. The contract lives in `resources/creator/app-theme-format.md`. Defaults stay in app.css; `design:docs` generates `src/shared/chrome-theme-tokens.generated.ts`, guarded by `design/chrome-theme-stale`.

Components still use tokens: no literals or allowlist growth. The dedicated palette module owns only its root overrides, preserving zoom/layout measurements. Security-decision/recovery controls use `chromeSafetyStyle`; baseline colors follow the current color-scheme without another listener.

Verify partial palettes, mode/system changes, frame notifications, preview cancellation/source invalidation, lifecycle failures, restart and one-click revert at 900px with the Inspector open. Test native Windows/Linux caption color branches; report unavailable native coverage honestly.
