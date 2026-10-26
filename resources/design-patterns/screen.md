# Screen patterns (one task: sign in, sign up, settings, checkout, onboarding step)

## Composition
- **One task per screen.** The H1 is the task ("Sign in to Bloom", "Where should we send it?"). Single column ≤ 480px (auth 400–440px), full-width fields.
- Order: identity (logo mark in a tinted tile + name), H1, one-line context, fields, primary action, alternatives, the escape link at the bottom ("New here? Create an account").
- Settings: a left list of sections or tabs; each section a titled group with a one-line description and its own Save; a separate "Danger zone" at the end.
- Checkout: ≤ 8 fields, summary on the right (desktop) with line items and the total in tabular figures; the button states the amount ("Pay $38.50").

## Fields and actions
- Label 13–14px above every field (never placeholder-as-label); field 44–56px tall, 1px border, 8–12px radius; hint under the label; focus = 2px ring with offset.
- One primary button (full width on narrow screens); alternatives as outline buttons or a text link; "or" divider between groups.
- Field-to-field 16–24px, group-to-group 32–48px, label-to-field 6–8px (the smallest gap on the screen).

## States
Show at least one: an inline error under a field in the danger colour with an icon and a fix ("Enter an email like name@example.com"), the button's loading label ("Signing in…") at the same width, a success confirmation. For settings, a toggle on and one off, a disabled control with the reason.

## Content
Realistic placeholders as format examples only ("name@example.com"). Buttons say what happens: "Create account", "Save changes", "Continue". No "Submit", no asterisks; mark optional fields "(optional)".

## Refuse → do instead
- A hero illustration filling half the auth screen → the form, the brand mark, generous space.
- Two equal primary buttons → one primary, one quiet alternative.
- Floating labels that vanish → persistent labels.
