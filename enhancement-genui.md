# Generative UI enhancement

**Reviewed:** 2026-11-16 · **Status:** researched proposal, not implemented.

This review compares CubiQ's existing inline widgets with the [AI SDK Generative User Interfaces guide](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces), its current interaction/data-stream documentation, and the related [Code Mode enhancement](enhancement-code-mode.md). It builds on [enhancement-creator-mode.md](enhancement-creator-mode.md), without assuming the present component/layout architecture is the final design.

## 1. Recommendation

**Evolve GenUI from parsed answer decorations into typed, source-backed, stateful presentation of tool results. Keep trusted React components in control; the model selects a supported presentation, not arbitrary executable UI.**

Use two compatible paths:

1. **Legacy/text path:** continue accepting bounded `ui:` JSON/compact fences from any agent. Normalize them into the shared widget contract, label model-authored data honestly, and preserve safe plain-text fallback.
2. **Structured/tool path:** host-validated tool/Code Mode results carry typed data, source/evidence and optional presentation metadata. Render the actual result directly instead of asking the model to reproduce it as another table/chart/fence.

The important AI SDK lesson is **tool result → trusted component + explicit lifecycle**. Installing `useChat` is not itself that architecture. Prefer a shared widget/event/action contract over the existing engine/IPC streams first; evaluate an AI SDK adapter or broader migration when it demonstrably reduces maintenance and passes the same cross-engine/history/security tests.

## 2. What the AI SDK guide and frontier GenUI standards teach

| Pattern / Source | Adopt in CubiQ |
|---|---|
| [AI SDK UI](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces): Tool output becomes component props. | Preserve authoritative structured data, types and source attribution; do not infer facts from styled prose. |
| [AI SDK 5/6 message parts](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage): Message parts have tool identity and state (`input-streaming` → `input-available` → `output-available` / `output-error`). | Stable execution/widget IDs, explicit loading/input/output/error/denied states and revision reconciliation over `tool-use` / `tool-result` events. |
| Client interaction returns tool output. | Typed, origin-bound answers/actions, with host acknowledgment and idempotency rather than immediately marking a local button “Sent”. |
| [AI SDK streaming data](https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data): Persistent data parts reconcile by ID; transient parts are not history. | Loading/progress stays ephemeral in [src/renderer/src/live.ts](src/renderer/src/live.ts); final data and meaningful user interactions persist in SQLite `events` and survive restart/handoff. |
| Approval is distinct from ordinary UI input. | Real grants/permission decisions use host-issued pending requests; generated choices/forms cannot approve themselves. |
| Google [A2UI (Agent-to-User Interface)](https://a2ui.org/) & CopilotKit [AG-UI](https://docs.copilotkit.ai/ag-ui): Separate transport stream (`AG-UI`), declarative component catalog (`createSurface` / `updateComponents`) and data model (`updateDataModel`). | Keep component specs declarative against our strict React catalog ([src/renderer/src/genui/UiBlock.tsx](src/renderer/src/genui/UiBlock.tsx)); separate display labels from semantic action IDs and bind large widgets to data references. |
| MCP [structuredContent & outputSchema](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content) & [SEP-1865 (MCP Apps / MCP-UI)](https://mcpui.dev/) | Route validated MCP `structuredContent` directly into tool-backed widgets without model re-serialization; align future persistent sandboxed panels (Creator Phase 4) with `SEP-1865` (`ui://` resources + JSON-RPC bridge). |

The [tool usage guide](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage) also documents dynamic tools, denied/error states and server-side approval protection against fabricated client history. Its examples are patterns, not a complete authorization system. CubiQ should keep authoritative approval state in the host and validate identity/revision/destination, not trust a client-supplied `approved:true`.

The current [RSC overview](https://ai-sdk.dev/docs/ai-sdk-rsc/overview) recommends AI SDK UI for production and describes RSC as experimental. Do not introduce a Next.js/RSC stack merely to add richer widgets to Electron. If adopting SDK APIs, pin/test the installed version rather than copying older `needsApproval` or `useChat` examples blindly.

### 2.1 Frontier Generative UI & Agent-to-UI protocol comparison (2025–2026)

1. **Vercel AI SDK 5/6 ([Generative UI](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces), [Tool Usage](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage), [Streaming Data](https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data)):**
   - **Architecture:** Replaces monolithic string messages with `message.parts`:
     - **Tool parts (`tool-<name>`):** Carry a deterministic state machine (`input-streaming` → `input-available` → `output-available` / `output-error` / `output-denied`) keyed by `toolCallId`. React components bind directly to `part.output` once `part.state === "output-available"`.
     - **Data parts (`data-<type>`):** Separate **transient** parts (ephemeral progress/status indicators that are never appended to message history) from **persistent** parts (settled structured artifacts reconciled in place when a new part arrives with the same `id`).
   - **CubiQ mapping:** CubiQ already separates ephemeral streaming state in `LiveThread` ([src/renderer/src/live.ts:15–21](src/renderer/src/live.ts#L15-L21)) from durable `StoredEvent` rows in SQLite ([src/main/db.ts:65–78](src/main/db.ts#L65-L78)), and pairs `tool-use` and `tool-result` events by `toolUseId` ([src/main/harness/loop.ts:283, 335](src/main/harness/loop.ts#L283)). Attaching a typed `WidgetEnvelope` to `tool-result.payload` gives CubiQ AI SDK's `output-available` data-to-component architecture across Claude, Codex, ACP, and the Native Harness without replacing its multi-engine transport.

2. **Google DeepMind & Flutter ([A2UI — Agent-to-User Interface](https://a2ui.org/)):**
   - **Architecture:** A declarative JSON streaming protocol built around three distinct message primitives:
     - `createSurface`: initializes a named UI container bound to a client-side **Component Catalog**.
     - `updateComponents`: streams or updates the declarative component tree (cards, tables, forms, selectors, charts) referencing catalog component types and data-binding paths rather than inline literal values.
     - `updateDataModel`: streams or patches the underlying typed JSON data model separately from the visual layout, and binds user interactions (`actionId` + typed input values) back to the agent with surface/revision identity.
   - **CubiQ mapping:** Directly solves the two P0 GenUI issues reproduced in CubiQ: (a) separating `label` (display text, which may be truncated with ellipsis in CSS) from semantic `id`/`value` in `ChoicesSpec` and `FormSpec` ([src/renderer/src/genui/validate.ts:17–20, 230–243](src/renderer/src/genui/validate.ts#L17-L20)), and (b) separating the widget's layout specification from large tool-produced datasets stored in `Store.writeBlob` ([src/main/db.ts:600–650](src/main/db.ts#L600-L650)).

3. **CopilotKit ([AG-UI — Agent-User Interaction Protocol](https://docs.copilotkit.ai/ag-ui)):**
   - **Architecture:** Standardizes the bidirectional event stream (`TEXT_MESSAGE_*`, `TOOL_CALL_*`, `STATE_SNAPSHOT`, `STATE_DELTA`) between agent runtimes and frontends, requiring explicit host acknowledgment and revision tracking when a frontend widget dispatches an action upstream.
   - **CubiQ mapping:** Replaces fire-and-forget `sendUiReply(text): boolean` ([src/renderer/src/genui/reply.ts:8–14](src/renderer/src/genui/reply.ts#L8-L14)) with an origin-bound, awaited action contract (`threadId`, `itemId`, `widgetId`, `revision`, `actionId`) that records consumed state in SQLite/store so virtualized transcript remounts ([src/renderer/src/components/ThreadView.tsx:179–215](src/renderer/src/components/ThreadView.tsx#L179-L215)) never re-enable an already-submitted control.

4. **Model Context Protocol ([`structuredContent` & `outputSchema`](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content)) & [SEP-1865 (MCP Apps / MCP-UI)](https://mcpui.dev/):**
   - **Architecture:**
     - `structuredContent` lets an MCP server return validated machine-readable JSON alongside short LLM-facing `content` text.
     - **SEP-1865 (MCP Apps)** extends MCP tools with `_meta.ui.resourceUri` pointing to a `ui://` HTML/JS bundle served by the MCP server, mounted by the host inside an opaque-origin sandboxed `<iframe>` and hydrated via a bidirectional JSON-RPC `postMessage` bridge.
   - **CubiQ mapping:** Gives CubiQ a clean two-tier extensibility model:
     - **Tier 1 (Default inline GenUI):** Native Ink Flat React components ([src/renderer/src/genui/UiBlock.tsx](src/renderer/src/genui/UiBlock.tsx)) hydrated by `ToolResult.data` / MCP `structuredContent` / `tool-result.payload`.
     - **Tier 2 (Creator Mode Phase 4 custom panels):** Opaque-origin sandboxed `ui://` panels following `SEP-1865` with host-rendered permission chrome outside the iframe.

5. **DeepSeek ([DeepSeek Harness UI registries](https://github.com/deepseek-ai/deepseek-harness)) & Z.ai ([GLM-4.6 / GLM-4.7 Artifacts & AutoGLM](https://z.ai/blog/glm-4.5)):**
   - **Architecture:** DeepSeek Harness uses disposable client UI slot registries that cleanly unmount when a plugin is disabled, plus incremental non-whitespace streaming checks to avoid empty layout frames. Z.ai trains GLM-4.6/4.7 for both high-accuracy structured JSON tool calls and self-contained HTML/SVG/Canvas artifact generation.
   - **CubiQ mapping:** Keep inline conversational widgets small, typed, and native to Ink Flat (`UiBlock.tsx`), while routing full-page HTML/SVG/Canvas creations to CubiQ's existing Artifact Preview and Design Canvas surfaces.

## 3. Current implementation and verified gaps

### 3.1 Useful foundation

- [genui/types.ts](src/renderer/src/genui/types.ts): nine component kinds—checklist, calculator, compare, timeline, chart, choices, form, stat and cards—with bounded bodies/items/text.
- [validate.ts:329–354](src/renderer/src/genui/validate.ts#L329-L354): JSON and compact line adapters normalize into a supported widget, otherwise fall back.
- [markdown.tsx:20–35](src/renderer/src/markdown.tsx#L20-L35): engine-independent text parsing with frozen streaming prefix and an unfinished-widget “Building…” state.
- [UiBlock.tsx](src/renderer/src/genui/UiBlock.tsx): known React components, not raw model HTML. This is a valuable security boundary.
- [formula.ts](src/renderer/src/genui/formula.ts): a bounded arithmetic parser without `eval`/`Function`; malformed/non-finite expressions fail safely.
- [SmartTable.tsx](src/renderer/src/genui/SmartTable.tsx): local filtering/sorting/chart/CSV presentation over ordinary Markdown tables.
- [link-preview.ts:39–90](src/main/link-preview.ts#L39-L90), [332–343](src/main/link-preview.ts#L332-L343): `ui:cards` image/page thumbnails are already mediated by the main process with DNS-lookup-time public IP validation (`isPublicAddress`), redirect re-checks, MIME/byte caps and `resolveInside` containment for local thread-folder images.
- [db.ts:79–83](src/main/db.ts#L79-L83), [600–611](src/main/db.ts#L600-L611), [1100–1105](src/main/db.ts#L1100-L1105) and [loop.ts:335](src/main/harness/loop.ts#L335): `ThreadEvent` (`kind: "tool-result"`) already carries a structured `payload?: unknown` field that SQLite automatically offloads to content-addressed SHA-256 `blobs` (`payload_ref`) when larger than 64 KiB, with `pruneBlobs()` garbage collection on thread/project deletion.

### 3.2 Reproduced issues

Harmless parser probes: [.ai/tmp/code-mode-genui-review/probe-results.json](.ai/tmp/code-mode-genui-review/probe-results.json).

| Priority | Finding | Needed change |
|---|---|---|
| P0 | An unterminated final `ui:choices` fence is accepted as a widget. [streaming.ts:23–28](src/renderer/src/streaming.ts#L23-L28) does not require the closing marker; the probe produced a valid choices spec. | Keep incomplete/aborted content inert. Complete structural validation and settled status are required before enabling interactions. |
| P0 | A 600-character choice option becomes a 500-character option/answer. [validate.ts:17–19](src/renderer/src/genui/validate.ts#L17-L19), [230–237](src/renderer/src/genui/validate.ts#L230-L237) clip the payload that [Choices](src/renderer/src/genui/components/Choices.tsx) sends. | Separate display label from stable option ID/value; never silently change user-selected semantic payloads. Reject oversized actions or use scoped value references. |

### 3.3 Source-backed lifecycle/accuracy gaps

These need focused UI integration tests before claiming all user-visible failure paths are reproduced:

- **Interaction identity:** [reply.ts:8–14](src/renderer/src/genui/reply.ts#L8-L14) targets the currently selected thread, with no source message/widget/revision argument. Bind to the originating context and reject stale/unavailable actions; do not guess a destination on click.
- **Acknowledgment:** `sendUiReply` returns true immediately, while sending may still fail. Choices/Form then set local picked/sent state. Model queue acceptance, delivery and operation completion need distinct statuses and retry behavior.
- **Remount durability:** choice/form state lives in component `useState`, while [ThreadView windowing](src/renderer/src/components/ThreadView.tsx#L179-L215) can unmount history. Used controls need stable persisted interaction state; remounting/restart must not silently re-enable an already-consumed action.
- **No typed data provenance:** widgets are derived from reply text, not a shared tool-output/data contract. A polished chart can still contain model-invented values. Distinguish model-authored, tool-backed, stale and incomplete data.
- **Validation diagnostics:** validators return `null` or normalize/pad/drop fields, not structured warnings. Display clipping, compatibility repair and semantic changes must be distinguished, especially for units, field IDs, formulas and interactive values.
- **Streaming work & positional keying:** [splitStreamingTail](src/renderer/src/streaming.ts#L119-L144) scans accumulated text; [memoizeByHash](src/renderer/src/streaming.ts#L147-L165) keys a 64-entry FIFO `Map` by the full `frozen` prefix string, evicting cached parses whenever a new paragraph or fence boundary closes during streaming. In [markdown.tsx:30–35](src/renderer/src/markdown.tsx#L30-L35), blocks are rendered with positional `key={i}`, so interactive widgets lose or alias component state if earlier blocks change. Use incremental block/data reconciliation with stable widget identity.
- **Eager dependencies:** [UiBlock.tsx:3–11](src/renderer/src/genui/UiBlock.tsx#L3-L11) imports every widget. Profile before lazy-loading; conditional JSX does not itself defer module parsing.
- **Large tables:** [SmartTable.tsx:139–145](src/renderer/src/genui/SmartTable.tsx#L139-L145) renders every filtered row and recomputes numeric/sort/filter derivations. Widget caps do not bound ordinary Markdown table size. Use row budgets/pagination/virtualization for real large datasets.
- **Numeric meaning:** [cellNumber](src/renderer/src/genui/SmartTable.tsx#L13-L23) removes currency/percent presentation (`[$€£¥]` and trailing `%`) before inferring a chart in [chartColumn](src/renderer/src/genui/SmartTable.tsx#L35-L46). Do not compare incompatible units/currencies as if they were the same quantity. Chart display rounds to two decimals; preserve underlying exact values and explain precision.
- **Trend semantics:** [Stat.tsx:11–15](src/renderer/src/genui/components/Stat.tsx#L11-L15) classifies delta direction solely by leading sign/arrow (`+↑▲` → `up`, `-−↓▼` → `down`); a rising churn or error value is not necessarily “good”. Carry explicit better-when/neutral semantics or keep unverified change neutral.
- **Export:** [SmartTable.tsx:26–32](src/renderer/src/genui/SmartTable.tsx#L26-L32) (`tableCsv` / `csvField`) only quotes `[",\n\r]`. RFC 4180 quoting is not spreadsheet formula safety: cells starting with `=`, `+`, `-` (non-numeric), `@`, `\t` or `\r` are copied raw. Provide a safe text-cell export policy while preserving legitimate typed negative numbers and offering an explicit raw export where needed.

### 3.4 End-to-end source trace of CubiQ's current GenUI pipeline

| Stage | Current implementation (`file:line`) | Verified behavior & architectural seam |
|---|---|---|
| **1. Prompt guidance** | [src/main/guide.ts:50–51, 100](src/main/guide.ts#L50-L51) | `UI_BLOCKS_NOTE` is injected into the guide prefix when `settings.uiBlocks === true`, teaching the compact `\|`-delimited line syntax in a single cache-stable line. |
| **2. Streaming tail split** | [src/renderer/src/streaming.ts:119–145](src/renderer/src/streaming.ts#L119-L145), [src/renderer/src/markdown.tsx:25–27, 124–132](src/renderer/src/markdown.tsx#L25-L27) | While `streaming === true`, `splitStreamingTail(text)` keeps an unclosed `ui:<name>` fence inside `tail` and renders `Building a <name>…`. However, once `streaming` flips to `false` (on turn completion, user Stop/abort in [loop.ts:205–208](src/main/harness/loop.ts#L205-L208), or token limit), `Markdown` passes the full `text` directly to `parseBlocks(text)`. |
| **3. Block parsing** | [src/renderer/src/streaming.ts:10–30](src/renderer/src/streaming.ts#L10-L30) | `parseBlocks` scans until `i < lines.length && !lines[i].trimStart().startsWith(fence[1])`. It does **not** check whether the closing fence line was actually found before emitting `{ type: "ui", name, body }`. Any truncated/aborted `ui:` block at the end of a settled reply is promoted into a live widget. |
| **4. Line/JSON normalization** | [src/renderer/src/genui/lines.ts:155–202](src/renderer/src/genui/lines.ts#L155-L202), [src/renderer/src/genui/validate.ts:329–355](src/renderer/src/genui/validate.ts#L329-L355) | `validateUi` accepts either `{...}` JSON or `parseUiLines` compact rows. In `validate.ts:17–20`, `text()` truncates every string at `UI_TEXT_MAX = 500` with `"…"`. For `validateChoices` (`validate.ts:230–243`), this mutates the option string itself. |
| **5. Component mount & state** | [src/renderer/src/markdown.tsx:30–35](src/renderer/src/markdown.tsx#L30-L35), [src/renderer/src/genui/UiBlock.tsx:17–55](src/renderer/src/genui/UiBlock.tsx#L17-L55), [Choices.tsx:6–28](src/renderer/src/genui/components/Choices.tsx#L6-L28), [Form.tsx:23–62](src/renderer/src/genui/components/Form.tsx#L23-L62) | `Markdown` keys blocks by array index `key={i}`. `Choices` (`picked`) and `Form` (`values`, `sent`) store interaction state in local React `useState`. When `ThreadView` windowing ([src/renderer/src/components/ThreadView.tsx:179–215](src/renderer/src/components/ThreadView.tsx#L179-L215)) unmounts off-screen turns or the user switches threads, `picked`/`sent` resets to `false`/`null`. |
| **6. Reply dispatch** | [src/renderer/src/genui/reply.ts:8–14](src/renderer/src/genui/reply.ts#L8-L14) | `sendUiReply(text)` reads `useStore.getState().selectedThreadId`, calls `s.enqueue(id, text)` or `void s.send(text)` without awaiting IPC acknowledgment, and returns `true` synchronously. |
| **7. Tool-result persistence & blobs** | [src/main/harness/loop.ts:335](src/main/harness/loop.ts#L335), [src/main/harness/tools/code-broker.ts:85](src/main/harness/tools/code-broker.ts#L85), [src/main/db.ts:600–650, 1100–1105](src/main/db.ts#L600-L650) | `tool-result` events already persist `payload: result.display?.result ?? text` in SQLite and automatically offload payloads $>64\text{ KiB}$ to SHA-256 files in `blobs/` (`payload_ref`), providing a ready-made durable channel for tool-backed GenUI widgets. |

## 4. Target architecture

### 4.1 Shared, versioned widget contract

Move the canonical serializable schema to shared code, with render-only components remaining in the renderer. Use one validation contract for host-generated data, script presentation requests, legacy fences, persistence and client actions. Blank numbers use explicit nullable values, not transport-level `NaN`.

An envelope identifies `schemaVersion`, `widgetId`, originating thread/turn/message or execution, `revision`, kind, state, typed props or a scoped data reference, provenance and any host-registered actions. Result/source references carry completeness/freshness and optional units/precision; they are not permission tokens.

Allow a small compositional vocabulary where tasks need it—table/stat/chart/compare/form/cards/progress/source panels and bounded row/column layouts—not arbitrary React trees, HTML, JavaScript, CSS or model-selected imports. Add useful presentations against representative tasks, not hundreds of widgets with overlapping purposes. Large result tables reference paged data rather than embedding every row in a model response.

### 4.2 Transport and persistence

Use typed start/update/seal/error/cancel events over the existing host/engine transport, or a tested SDK adapter. UI data comes from a validated result/presentation boundary. Preserve model-history truth separately from display projection, especially when a provider binds thinking to exact previous messages.

Persist settled widget snapshots/result references and durable interaction state. Progress/draft updates stay ephemeral and size-bounded. Reconnect/replay reconstructs the latest state without executing effects or resending answers. Use monotonic revisions to ignore duplicate/out-of-order/stale events. Imported older widgets remain readable; unknown schemas fall back safely with an explicit compatibility message.

### 4.3 Tool-backed versus model-authored UI

- **Tool-backed:** validated source result, operation identity, observation timestamp/revision, data coverage and permitted actions. “Tool-backed” does not mean the external data is infallible or automatically authorized.
- **Model-authored:** unverified illustration/explanation, with supported bounded props and no grants. Preserve the content, but do not imply its statistics were measured.
- **Computed:** deterministic Code Mode output with its input evidence and incomplete/error metadata. A successfully executed aggregate is still partial when some sources failed or were clipped.

The model should explain what the data means and what remains uncertain. It should not spend tokens reproducing a large dataset solely to activate a UI component.

### 4.4 Concrete v2 TypeScript contracts (`src/shared/genui.ts`)

```ts
export type WidgetProvenance =
  | { kind: "model-authored" }
  | { kind: "tool-backed"; toolUseId: string; operationId: string; observedAt: number; exhaustive?: boolean }
  | { kind: "computed"; scriptCallId: string; sources: string[]; exhaustive: boolean };

/** Separates display label (view-clipped) from the semantic payload sent on interaction. */
export interface ChoiceOptionSpec {
  id: string;
  label: string;
  /** Exact semantic text/value submitted when clicked; never silently clipped. */
  value: string;
}

export interface WidgetEnvelope<Spec = UiSpec> {
  schemaVersion: 1;
  widgetId: string;
  threadId: string;
  /** Message itemId or toolUseId that owns this widget. */
  ownerId: string;
  revision: number;
  state: "drafting" | "ready" | "failed" | "cancelled";
  provenance: WidgetProvenance;
  spec: Spec;
  /** Optional content-addressed blob reference (Store.writeBlob) for large tabular datasets. */
  dataRef?: { sha256: string; bytes: number; totalRows: number };
}

export interface WidgetActionRequest {
  threadId: string;
  ownerId: string;
  widgetId: string;
  revision: number;
  actionId: string;
  /** Stable idempotency key (`${threadId}:${ownerId}:${widgetId}:${revision}`) to prevent duplicate submission across remounts. */
  idempotencyKey: string;
  payload: { kind: "choice"; optionId: string; value: string } | { kind: "form"; values: Record<string, string | number | boolean> };
}

export type WidgetActionAck =
  | { ok: true; status: "sent" | "queued" | "already-consumed"; eventSeq?: number }
  | { ok: false; reason: "stale-revision" | "wrong-thread" | "invalid-payload" | "closed-thread"; message: string };
```

For GU0 (`streaming.ts`, `validate.ts`, `reply.ts`, `SmartTable.tsx`), four concrete code changes establish immediate safety:

1. **Closed-fence requirement in `parseBlocks` ([src/renderer/src/streaming.ts:20–30](src/renderer/src/streaming.ts#L20-L30)):** Track `const closed = i < lines.length && (lines[i] ?? "").trimStart().startsWith(fence[1]!)`. Emit `{ type: "ui" }` only when `closed === true`; otherwise emit `{ type: "code" }` (inert plain code block) so an aborted or token-capped reply never renders a half-streamed interactive widget.
2. **Unclipped semantic option values ([src/renderer/src/genui/validate.ts:230–243](src/renderer/src/genui/validate.ts#L230-L243)):** Normalize each choice into `{ id, label, value }` where `label` is display-capped (`UI_TEXT_MAX`) while `value` preserves the exact validated string (or rejects the widget if `value` exceeds an explicit action payload ceiling, e.g., 2,000 chars, instead of silently mutating it with `"…"`).
3. **Origin-bound, remount-safe `sendUiReply` ([src/renderer/src/genui/reply.ts:8–14](src/renderer/src/genui/reply.ts#L8-L14)):** Pass `{ threadId, ownerId, widgetId, text }` into `sendUiReply`, verify the target thread exists, await the store's `send`/`enqueue` promise, and record the consumed `idempotencyKey` in `useStore` (persisted in thread state) so `ThreadView` virtualization never resets a used `<Choices>` or `<Form>`.
4. **Spreadsheet-safe CSV escaping ([src/renderer/src/genui/SmartTable.tsx:26–32](src/renderer/src/genui/SmartTable.tsx#L26-L32)):** Prefix a leading `' ` (or tab) inside quoted CSV cells when a non-numeric string starts with `[=+\-@\t\r]` while leaving valid negative numbers (`/^-\d+(\.\d+)?$/`) untouched.

## 5. Interactions and streaming

### States

Use an explicit lifecycle: drafting/loading → ready or failed/cancelled. Action states add submitting, queued/accepted, succeeded, rejected, expired and stale as applicable. Render only structurally valid intermediate display data; actions require a sealed valid payload and a current host registration.

Do not infer an action's success from a click, a queued message or a local state flag. A host acknowledgment determines accepted/failed delivery; an operation result determines completion. A stale widget can remain viewable while its old action is disabled with an explanation.

### Action contract

User interaction carries widget ID, origin, revision, action ID and typed values. Validate again in the host against the original schema and a currently registered action; check authorization and idempotency. Reject a duplicate, old revision, wrong thread, disallowed value or expired action before executing anything.

There are three separate action categories:

1. **Local presentation:** filter/sort/calculate/copy; no model call or external effect.
2. **Agent input:** submit a choice/form as a compact typed answer tied to its original question; show that the entered values are sent to the selected agent.
3. **Host operation:** a registered permitted operation through the shared capability boundary, with its normal approval requirements. Generated “Approve” buttons are never the trusted permission UI.

Collect credentials only in the trusted credential/settings flow, not an agent-generated form. Protect numeric/select/toggle requirements with host validation rather than assuming HTML input types prove the submitted value is valid.

## 6. Accuracy, safety and performance

- Preserve raw/typed values separately from labels. Do not clip IDs, option values or formulas to make them fit. Display ellipsis is a view concern; semantic truncation/repair is explicit or rejected.
- Attach units/currency, precision, sources, time/revision and data coverage. Do not infer a common unit merely because all cells parse as numbers, or infer outcome quality from delta sign.
- Decode JSON/compact text into the same schema. Keep legacy parsing compatible where it is unambiguous; reject incomplete markup and do not progressively enable a partly generated form.
- Maintain a fixed component allowlist and bounded tree/item/body depth/size. Model output does not execute code, import a component, touch raw IPC or grant capabilities.
- Link/image loading remains opt-in and host-mediated, with existing public-host, redirect/MIME/size/time defenses. Rendering a card is not permission to fetch arbitrary URLs.
- Lazy-load genuinely expensive widgets, memoize stable props/derived data, virtualize/paginate large tables and preserve keyboard focus/action state across mounts.
- Use per-widget/per-thread subscriptions and stable IDs. Reconcile only changed blocks/rows instead of reparsing/rerendering a growing conversation for every delta.
- Provide accessible labels, status announcements without token-by-token noise, focus return, semantic tables and text alternatives for charts. Check contrast/themes, 900px width and reduced motion under [DESIGN.md](DESIGN.md) and [the quality checklist](docs/design/quality-checklist.md).
- Treat widget/tool errors as structured safe outcomes. Sanitize before producing canonical model-visible results; a UI-only redaction must not accidentally alter replayed model history or invalidate bound thinking.

## 7. Delivery and verification

### Options considered

| Option | Assessment |
|---|---|
| Add more fence names only | Useful for small legacy answers, but insufficient for lifecycle, identity and tool-data accuracy. |
| Shared typed widgets + host actions over current transports | Recommended first target: fits all agent engines, preserves existing conversations and fixes the actual semantic boundary. |
| AI SDK UI with custom transport/engine adapters | Credible alternative. Build a small proof-of-concept and compare maintenance, payload/state handling and all-engine behavior before migrating. |
| AI SDK RSC / arbitrary generated component code | Not the production-default path recommended by the SDK; introduces unsuitable framework/runtime concerns for this Electron flow. Persistent authored code belongs to explicit sandboxed Creator extensions. |

### Batches

1. **GU0:** inert incomplete widgets; unchanged action payloads; origin/revision binding; acknowledgment and remount-safe consumed state.
2. **GU1:** shared versioned schemas, typed result/source/coverage contracts and legacy adapter diagnostics.
3. **GU2:** structured tool/Code Mode result parts, explicit lifecycle events and idempotent host actions.
4. **GU3:** incremental streaming, scoped subscriptions, paged/virtual tables, units/precision/trend/export correctness and useful bounded compositions.
5. **GU4:** evaluate AI SDK integration and additional widgets through real cross-engine tasks; migrate only where it earns its cost.

Acceptance cases include partial/cancelled fences, invalid schemas, very long labels/values, duplicate choices, stale revisions, wrong-thread actions, failed send, queued send, duplicate click/replay, history virtualization, restart, mixed-unit tables, negative/zero/precise values, large paged datasets, clipboard failure and declined link loading. Actions must never run merely from rendering or replaying a message.

Measure first useful UI, input responsiveness while streaming, update cost/DOM size, payload/returned tokens, data fidelity, user-action success and total task completion. Keep richer UI when it helps the user; do not optimize for the number of rendered widgets.

**Verification completed:** the targeted existing Code Mode/GenUI suite passed **153 tests across 12 files** in **32.61 seconds**. The separate local probes reproduced incomplete-fence acceptance and choice-payload clipping not covered by that passing baseline. See [the verification record](.ai/tmp/code-mode-genui-review/verification.md). The full suite/typecheck/build, real provider evaluations and live Electron/accessibility/platform checks were not performed for this proposal. Application source and dependencies remain unchanged; implementation requires explicit batch approval.

## 8. Sources

1. [AI SDK Generative User Interfaces](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces).
2. [AI SDK chatbot tool usage: lifecycle, interactions, approvals and history caveats](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage).
3. [AI SDK streaming custom data: persistent/transient parts and ID reconciliation](https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data).
4. [AI SDK RSC overview: recommends AI SDK UI for production](https://ai-sdk.dev/docs/ai-sdk-rsc/overview).
5. [Google A2UI (Agent-to-User Interface) declarative UI specification](https://a2ui.org/).
6. [CopilotKit AG-UI (Agent-User Interaction Protocol) documentation](https://docs.copilotkit.ai/ag-ui).
7. [Model Context Protocol (MCP): structuredContent and outputSchema](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content).
8. [MCP Apps Extension (SEP-1865 / MCP-UI) specification and overview](https://mcpui.dev/).
