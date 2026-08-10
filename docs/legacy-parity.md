# Legacy behavior audit

The vNext rules and task model were checked against the public legacy sources:

- `todorant-frontend/src/components/Rules.vue` for the authenticated Rules entry point and keyboard close behavior.
- `todorant-frontend/src/assets/localization.ts` for the English canonical rule set, planning copy, frogs, skips, ordering, tags, and current-task behavior.
- `todorant-backend/src/models/todo/Todo.ts`, `models/user/User.ts`,
  `models/tag.ts`, and `models/report.ts` for the exact Mongo collections and fields.

## Carried forward

- Immediate capture and explicit, actionable task wording.
- Date-based monthly/daily planning, a planning lock for overdue work, and deliberate
  redistribution of unfinished work (two redistributions make a frog).
- A focused first current task, linear ordering, reorder controls, and frogs before ordinary work.
- Frog and skip history, including the rule that a frog cannot be skipped.
- Notes/context, immutable completion/conflict history, tags, epic progress, settings,
  working delegation, aggregate/public reports, export, and client-side encryption.
- A compact Rules dialog available from every authenticated task view, with native Escape/dialog behavior.

## Migration boundary

- Legacy todos are read from `todos` by `user`/`delegator`; settings and delegates
  come from the verified user document; epics come from `tags`; reports come from
  `reports`. The importer understands `monthAndYear`, `date`, `order`, `repetitive`,
  `frogFails`, `skipped`, delegation, and encrypted ciphertext.
- Import requires the signed-in email plus the legacy account token. Only allowlisted
  fields leave Mongo; auth tokens, invite tokens, and calendar credentials are never
  retained or exported. Runtime credentials must have server-verifiable read-only
  privileges and all operations use secondary reads with retryable writes disabled.
- Legacy `repetitive` remains a conscious copy/breakdown prompt. There is no automatic
  cadence model. Tags and epics remain visible organization instead of folders.
