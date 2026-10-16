# Trade-off Checklist

Run each question against every live option before choosing. Skip a category only when it truly does not apply, and say so in the design note.

## Coupling
- Does the option add a call between modules, or shared state they did not share before?
- Can the new component be removed or replaced without touching its callers?
- Does it reach into internals of another module that are not part of its public interface?

## Data migration
- Does existing data change shape, and can old readers still read it during the transition?
- Can the migration run while the system serves traffic, and is it reversible?
- How long does it take at realistic volume, and what happens if it fails halfway?

## Backwards compatibility
- Which interfaces, schemas or behaviors are visible outside the change, and do any break?
- Can old and new versions run side by side during the rollout?
- For each break: who calls it, and what is their fix?

## Security
- Does the option take new input, open a new path to data, or widen an existing permission?
- Where is that input validated, and who can reach the new surface?

## Observability
- Can the team tell the feature is working, and failing, from logs, metrics or traces?
- Is there a signal that fires before users notice a problem?

## Cost
- What does the option add in compute, storage, network or human upkeep at expected scale?
- Which cost grows with traffic, and at what point does it start to matter?
