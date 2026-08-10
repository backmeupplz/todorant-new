# Legacy workflow and UI audit

The vNext workflow was checked against the public legacy sources in
`backmeupplz/todorant-frontend`: `Superpower.vue`, `Navbar.vue`,
`current/CurrentTodo.vue`, `current/ProgressBlock.vue`, `planning/Planning.vue`,
`planning/PlanningHeader.vue`, `TodoCard/*`, `TodoForm/*`, `Rules.vue`, and the
English rules in `assets/localization.ts`.

## Retained

- The primary signed-in workflow is Current, Planning, Report, and Delegation.
  Rules stay one click away; settings and secondary data views stay in a compact menu.
- Current presents exactly one actionable task, frogs first, with day progress. Overdue
  planning debt locks Current until the user deliberately reschedules unfinished work.
- Planning keeps date/month groupings, today/month filtering, completed/search/order
  controls, add-for-date actions, drag ordering, and direct date redistribution.
- Task cards keep task text as the strongest element, with notes, schedule/time, tags,
  frog/repetitive/skipped/encrypted state, delegation, breakdown, skip, complete,
  reorder, delete, and immutable history.
- The 17 English rules are copied verbatim from the legacy localization source. They
  retain immediate capture, actionable wording, conscious planning, Current-only focus,
  frogs first/no frog skipping, breakdown, hashtags instead of projects, and no automatic
  repeating-task cadence.
- Explicit revisions, offline operations, realtime events, conflict preservation,
  encryption, reports, delegation, export, and the read-only idempotent importer remain.

## Intentionally improved

- The old multi-library Vue/Vuetify shell is replaced by semantic Preact and native
  controls. Desktop uses compact tabs; narrow screens use a thumb-reachable bottom bar.
- Controls have visible focus, semantic labels, responsive layouts, dark mode, reduced
  visual noise, and 44 px touch targets on mobile. Add task is contextual instead of a
  competing permanent destination.
- Dense 12 px cards retain the legacy orange/blue language, while overdue work receives
  a restrained tint and state indicators stay subordinate to task text.
- Calendar scope uses a compact native month control. Reordering uses native drag/drop
  plus accessible up/down controls, avoiding a large runtime dependency.

## Epic removal and migration boundary

Epics are retired from task/domain/API types, settings, sync operations, reports, UI,
tests, current PostgreSQL task state, browser storage, and export surfaces. Historical
server events remain immutable at rest, while API/export boundaries strip retired epic
fields so they cannot re-enter the product.

Legacy tags previously marked as epics are imported as ordinary hashtag records after
their epic-only metadata is removed. Task text and hashtags are retained; tasks,
unrelated settings, delegation, history, and report aggregates are not deleted. Existing
persisted legacy epic-tag records are converted to ordinary tag records by migration.

Legacy Mongo access remains read-only and idempotent: imports require verified ownership,
secondary reads, retryable writes disabled, allowlisted output, and no writes to the
legacy database.
