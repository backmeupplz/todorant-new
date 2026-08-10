# Legacy behavior audit

The vNext rules and task model were checked against the public legacy sources:

- `todorant-frontend/src/components/Rules.vue` for the authenticated Rules entry point and keyboard close behavior.
- `todorant-frontend/src/assets/localization.ts` for the English canonical rule set, planning copy, frogs, skips, ordering, tags, and current-task behavior.
- The legacy task/settings/report concepts represented by the public frontend models and backend API names.

## Carried forward

- Immediate capture and explicit, actionable task wording.
- Date-based monthly/daily planning and deliberate redistribution of unfinished work.
- A focused first current task, linear ordering, reorder controls, and frogs before ordinary work.
- Frog and skip history, including the rule that a frog cannot be skipped.
- Notes/context, completion history, tags, epics, settings, ownership/delegation fields, export, and encryption metadata.
- A compact Rules dialog available from every authenticated task view, with native Escape/dialog behavior.

## Deliberate vNext updates

- The product requirements explicitly add repetitive tasks, so the old prohibition is replaced with conscious repeat rules and explicit occurrence skips.
- Tags and epics remain visible organizational metadata instead of deep folder navigation.
- The current task remains visually first, while the compact Today view keeps the rest of the ordered day visible for quick planning and accessible keyboard/mobile operation.
