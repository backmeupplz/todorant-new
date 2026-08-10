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
  schedule: { month: null, date: null, time: null, timezone: null },
  repetitive: false,
  frogFails: 0,
  skippedDates: [],
  tags: [],
  epicId: null,
  frog: false,
  rank: rankBetween(context.beforeRank, context.afterRank),
  ownerId: context.userId,
  delegateId: null,
  delegation: null,
  legacyDelegation: null,
  encryption: null,
  parentId: null,
  revision: 0,
  createdAt: context.now,
  updatedAt: context.now
});

export function applyOperation(context: ApplyContext): { task: Task; conflict: Conflict | null } {
  const { operation, now } = context;
  if (
    operation.deviceId !== "legacy-import" &&
    operation.changedFields.schedule?.month === now.slice(0, 7) &&
    !operation.changedFields.schedule.date
  ) {
    throw new Error("Tasks in the current month need a specific date");
  }
  if (operation.command !== "create" && context.current === null) {
    throw new Error("Task not found");
  }
  if (operation.command === "create" && context.current !== null) {
    throw new Error("Task already exists");
  }

  const original = context.current ?? defaults(context);
  const operationFields = touchedFields(operation);
  // Tag commands carry their intent as add/remove sets. Applying that delta to
  // the canonical set is commutative for independent changes, so a stale tag
  // operation must not conflict merely because another client touched tags.
  const conflictingFields = operationFields.filter((field) =>
    context.fieldsChangedAfterBase.includes(field) && !(operation.command === "tags" && field === "tags")
  );

  if (original.deletedAt !== null && !canApplyToTombstone(operation)) {
    const tombstoneFields = touchedFields(operation);
    const canonical = { ...original, revision: original.revision + 1, updatedAt: now };
    const conflict: Conflict = {
      id: crypto.randomUUID(),
      taskId: original.id,
      operationId: operation.operationId,
      fields: tombstoneFields,
      mine: operation,
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
  if (
    operation.deviceId !== "legacy-import" &&
    operation.changedFields.schedule &&
    original.completedAt === null &&
    original.schedule.date &&
    original.schedule.date <= now.slice(0, 10) &&
    (next.schedule.date ?? `${next.schedule.month ?? "9999-99"}-99`) > original.schedule.date
  ) {
    next.frogFails = original.frogFails + 1;
    if (next.frogFails >= 2) next.frog = true;
  }

  switch (operation.command) {
    case "complete":
      if (!conflictingFields.includes("completedAt")) next.completedAt = now;
      break;
    case "reopen":
      if (!conflictingFields.includes("completedAt")) next.completedAt = null;
      break;
    case "skip":
      if (!operation.skipDate) throw new Error("skipDate is required");
      if (next.frog) throw new Error("Frog tasks cannot be skipped");
      if (!conflictingFields.includes("skippedDates")) {
        next.skippedDates = normalizeTags([...next.skippedDates, operation.skipDate]);
      }
      break;
    case "delete":
      if (!conflictingFields.includes("deletedAt")) next.deletedAt = now;
      break;
    case "restore":
      if (!conflictingFields.includes("deletedAt")) next.deletedAt = null;
      break;
    case "reorder":
      if (!conflictingFields.includes("rank")) next.rank = rankBetween(context.beforeRank, context.afterRank);
      break;
    case "tags": {
      if (!conflictingFields.includes("tags")) {
        const add = operation.tagChanges?.add ?? [];
        const remove = new Set(operation.tagChanges?.remove ?? []);
        next.tags = normalizeTags([...next.tags.filter((tag) => !remove.has(tag)), ...add]);
      }
      break;
    }
    case "delegate-assign":
      if (!operation.delegationUserId) throw new Error("A delegate is required");
      if (!conflictingFields.includes("delegation")) {
        next.delegateId = null;
        next.delegation = { delegateId: operation.delegationUserId, status: "pending", updatedAt: now };
      }
      break;
    case "delegate-accept":
      if (!next.delegation || next.delegation.status !== "pending") throw new Error("Delegation is not pending");
      if (!conflictingFields.includes("delegation")) {
        next.delegateId = next.delegation.delegateId;
        next.delegation = { ...next.delegation, status: "accepted", updatedAt: now };
      }
      break;
    case "delegate-reject":
      if (!next.delegation || next.delegation.status !== "pending") throw new Error("Delegation is not pending");
      if (!conflictingFields.includes("delegation")) {
        next.delegateId = null;
        next.delegation = { ...next.delegation, status: "rejected", updatedAt: now };
      }
      break;
    case "delegate-revoke":
      if (!next.delegation || !["pending", "accepted"].includes(next.delegation.status)) {
        throw new Error("Delegation is not active");
      }
      if (!conflictingFields.includes("delegation")) {
        next.delegateId = null;
        next.delegation = { ...next.delegation, status: "revoked", updatedAt: now };
      }
      break;
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
        mine: operation,
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
