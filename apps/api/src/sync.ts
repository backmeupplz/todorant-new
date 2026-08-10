import {
  canApplyToTombstone,
  normalizeTags,
  rankBetween,
  touchedFields,
  type Conflict,
  type MutableTaskField,
  type Task,
  type TaskOperation
} from "@todorant/domain";

export type ApplyContext = {
  current: Task | null;
  operation: TaskOperation;
  fieldsChangedAfterBase: string[];
  beforeRank: string | null;
  afterRank: string | null;
  now: string;
  userId: string;
};

const defaults = (context: ApplyContext): Task => ({
  id: context.operation.taskId,
  userId: context.userId,
  text: "",
  note: "",
  completedAt: null,
  deletedAt: null,
  schedule: { date: null, time: null, timezone: null },
  repeat: null,
  skippedDates: [],
  tags: [],
  epicId: null,
  frog: false,
  rank: rankBetween(context.beforeRank, context.afterRank),
  ownerId: context.userId,
  delegateId: null,
  encryption: null,
  revision: 0,
  createdAt: context.now,
  updatedAt: context.now
});

export function applyOperation(context: ApplyContext): { task: Task; conflict: Conflict | null } {
  const { operation, now } = context;
  if (operation.command !== "create" && context.current === null) {
    throw new Error("Task not found");
  }
  if (operation.command === "create" && context.current !== null) {
    throw new Error("Task already exists");
  }

  const original = context.current ?? defaults(context);
  const conflictingFields = Object.keys(operation.changedFields).filter((field) =>
    context.fieldsChangedAfterBase.includes(field)
  ) as MutableTaskField[];

  if (original.deletedAt !== null && !canApplyToTombstone(operation)) {
    const tombstoneFields = touchedFields(operation);
    const canonical = { ...original, revision: original.revision + 1, updatedAt: now };
    const conflict: Conflict = {
      id: crypto.randomUUID(),
      taskId: original.id,
      operationId: operation.operationId,
      fields: tombstoneFields,
      mine: operation.changedFields,
      canonical,
      createdAt: now
    };
    return { task: canonical, conflict };
  }

  const acceptedFields = Object.fromEntries(
    Object.entries(operation.changedFields).filter(([field]) => !conflictingFields.includes(field as MutableTaskField))
  );
  const next: Task = {
    ...original,
    ...acceptedFields,
    revision: original.revision + 1,
    updatedAt: now
  };

  switch (operation.command) {
    case "complete":
      next.completedAt = now;
      break;
    case "reopen":
      next.completedAt = null;
      break;
    case "skip":
      if (!operation.skipDate) throw new Error("skipDate is required");
      if (next.frog) throw new Error("Frog tasks cannot be skipped");
      next.skippedDates = normalizeTags([...next.skippedDates, operation.skipDate]);
      break;
    case "delete":
      next.deletedAt = now;
      break;
    case "restore":
      next.deletedAt = null;
      break;
    case "reorder":
      next.rank = rankBetween(context.beforeRank, context.afterRank);
      break;
    case "tags": {
      const add = operation.tagChanges?.add ?? [];
      const remove = new Set(operation.tagChanges?.remove ?? []);
      next.tags = normalizeTags([...next.tags.filter((tag) => !remove.has(tag)), ...add]);
      break;
    }
    case "create":
    case "update":
      break;
  }

  const conflict: Conflict | null = conflictingFields.length
    ? {
        id: crypto.randomUUID(),
        taskId: next.id,
        operationId: operation.operationId,
        fields: conflictingFields,
        mine: Object.fromEntries(
          Object.entries(operation.changedFields).filter(([field]) =>
            conflictingFields.includes(field as MutableTaskField)
          )
        ),
        canonical: next,
        createdAt: now
      }
    : null;
  if (conflict) conflict.canonical = next;
  return { task: next, conflict };
}

export function changedFieldsFor(operation: TaskOperation): string[] {
  return touchedFields(operation);
}
