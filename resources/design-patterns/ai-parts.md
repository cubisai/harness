# AI product parts (assistants, agents, copilots)

Draw the work the AI did, not a glowing orb. Every part shows real content: the question, the sources, the tool, the timing, the cost.

## Anatomies
- **Answer**: the question as a quiet line; the answer in reading type with numbered citation chips inline ([1]); a row of 3–6 source cards (favicon or app icon, site/app name, one-line title, number); under it, feedback (thumbs, copy, retry) and "Not accurate / Out of date" chips after a thumbs-down.
- **Composer**: a 2–4 line field ("Ask anything…" only as a placeholder) inside a bordered box; below it a toolbar: attach (+), a context chip ("Request approval", a picked file), the model or mode picker ("Auto ⌄"), mic, and a send button that is disabled until there's text. Connected-app icons and a "Connect apps" link sit under the box.
- **Working state**: a compact panel with a status line and a live timer ("Thinking · 8s"), then the steps so far ("Searching", "Reading 6 sources") with the sources as small chips; a Stop button. A one-line pill version ("Thinking" with a small spinner) for tight spots.
- **Tool call card**: tool name in a mono pill (`gmail.send`), a one-line summary of the arguments, duration ("0.5s"), status (spinner / check / error), and a chevron that expands to the input and the result. Calls nest under the step that made them.
- **Approval**: what the agent wants to do, in plain words; why; what it touches (recipient, amount, file) as a label/value list; the risk if any; buttons Approve (primary), Edit, Deny. An "always allow for this tool" checkbox only when it's safe.
- **Agent run**: a header with the run name, a status pill (Running · Waiting · Done · Failed), the start time and elapsed, Stop. A plan card with numbered steps (title, one muted line, the tool pill, a timing on the done ones, a spinner on the active one, "Running · 2 of 5" at the bottom). An activity list below. A right rail: "Needs your input" (empty state until an approval arrives), the draft it is writing, details (agent, triggered by, tool calls, cost).
- **Change review**: the text or code with deletions struck through on a soft red and insertions on a soft green; "3 of 9" with ‹ ›, Reject all and Accept all; a one-line summary of what changed above.
- **Usage meter**: used / limit with units ("41,200 of 50,000 tokens"), a thin bar that turns warning at 80% and danger at 100%, the reset date, an "Upgrade" or "Set limit" link.
- **Model picker**: a menu of models with provider icon, name, a one-line strength, context size, relative price ($ / $$) and speed; the current one checked; "Auto" first when the product routes for you.
- **Inbox of decisions**: rows of things waiting on a person (agent, what, since when, urgency), with inline Approve / Open; a count in the nav.

## Rules
- Show the AI's output as product content in the style's normal type and surfaces (not purple gradients, sparkles or a glowing avatar).
- Timings, counts and costs in tabular figures; tool names and keys in mono.
- Draw at least one in-between state: working, waiting for approval, or failed with a retry.
