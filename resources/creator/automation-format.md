# Scheduled prompt format

An automation runs a custom prompt on the existing local scheduler in **this project**. Creator stages a review card; it cannot start a run or enable a schedule. No presets, experts, new connector infrastructure, commands or delivery channels.

Inspect installed first to avoid collisions. Call `creator_propose` with `kind: "automation"`, `scope: "project"`, a lowercase dash name, and `config` as a JSON **string**:

```json
{"title":"Morning project brief","prompt":"Summarize project changes. Do not change files or external data.","schedule":{"kind":"daily","at":"09:00","days":[1,2,3,4,5],"timeZone":"Asia/Bangkok"},"missed":"skip","budgetUsd":0.25}
```

- Config ≤64 KB, title ≤120 bytes, nonempty prompt ≤32 KB. No extra fields.
- Schedule: `{"kind":"interval","everyMinutes":30}` (integer 1–10080), or daily with HH:MM, a valid IANA timezone, and optional unique weekday numbers 0=Sun through 6=Sat. Omitted days means every day; an empty list is invalid. Ask for timezone/time when not known; don't invent it.
- `missed`: `skip` (default) or `coalesce` (run once to catch up).
- `budgetUsd`: positive finite amount per run, or null/omitted for no limit. Make the budget clear to the user; do not invent permission to spend.
- Agent/model default to the Creator thread's selection. Optional `agent`/`model` must be available; null model means that engine's default. No automatic provider fallback.
- **Off/Ask is mandatory at install/update.** Do not supply `enabled`, `permissions`, `template`, `preset`, `expert`, `projectId` or arbitrary source/destination fields. The user can later enable it or choose Unattended in the existing editor.
- Chats has no real project folder: ask the user to open a project.
- No row, thread, connector call or model turn happens during staging. Only the user installs. The user separately enables it or clicks Run now in Library → Automations; scheduled tools retain Ask even if the default thread mode is Full access.
- Same-name Update only changes a matching Creator-owned automation, keeps run history and leaves it Off. Modified settings or an active run are protected. Uninstall never removes an unrelated manually-created automation.
