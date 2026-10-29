# Workspace patterns (dashboards, admin, data tables, project tools)

## Composition
- **Shell**: a 232–264px left sidebar (workspace switcher on top, 4–7 sections with icons, the current one filled with a 2px accent bar, the user at the bottom), a 48–56px top bar (page title + record count, date range, compare toggle, one primary action, search with a ⌘K hint). Content on a 12-column grid, 16–24px gutters.
- Lead with the work: the page title and the data, not a hero or intro copy.
- A **status strip** under the top bar with 2–4 domain facts ("Dispatch 06:45 · Silos 84% · Deadline 11:30") makes it feel real.
- Density: 13–14px body, 32–40px rows, 12px gutters inside panels. Radius 4px controls, 6–8px panels; never pill-shaped rows.
- Separate panels with 1px outline-variant borders and the surface ladder (surface → surface-container-low → -high), not shadows.

## Type
- UI sans for text; **a mono or tabular face for every number, ID and small label** (`font-variant-numeric: tabular-nums`). Column headers 11–12px uppercase with +0.04em tracking, or sentence case 12px medium — pick one.
- KPI values 24–32px, tracking −0.02em.

## Anatomies
- **KPI tile** (≤ 4 per row): label · value with unit · delta chip (↑ +6.2%, coloured by meaning) · comparison ("prev $45,395" or "target < 2.5%") · sparkline · one context line. A number without a comparison is decoration.
- **Chart panel**: title as a finding or metric name, the time range, direct labels or a 2-item legend, a dashed previous-period line, the highlighted point with a tooltip drawn, gridlines in the lightest outline. Bars for categories, lines for time; skip pie/donut unless parts of a whole ≤ 4.
- **Table**: toolbar (count chip, search, 1–2 filter selects, active-filter chips with Clear), header row, 2-line cells for entities (name + secondary), numbers right-aligned, status pills with text, a row ⋮ menu always visible, pagination with range ("1–25 of 312"). Show one hovered row and one selected row.
- **Kanban**: columns with name + count + add; cards with mono ID, priority tag, title (2 lines max), meta row (subtasks 2/4, due date, comments), assignee initials. Show a drag placeholder (dashed) if the brief mentions dragging.
- **Detail side panel** (420–480px): title, a label/value property grid (Status, Priority, Assignee, Due, Tags), description, checklist, activity with real comments, a composer at the bottom.

## States
Draw at least one: loading skeleton rows, an empty filtered result ("No orders match 'refunded' · Clear filters"), an error banner with retry. Hover, selected and focus must differ visibly.

## Refuse → do instead
- Marketing hero, eyebrows, gradient headings on an app screen → title + data.
- Donut + gauge + 3-D charts → bars and lines with direct labels.
- Rainbow status colours → red/amber/green only for status; one accent for selection and the primary action.
- Hover-only row actions → visible ⋮.
