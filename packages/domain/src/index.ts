export type TaskSchedule = {
  date: string | null;
  time: string | null;
  timezone: string | null;
};

export type RepeatRule = {
  cadence: "daily" | "weekly" | "monthly" | "custom";
  interval: number;
  weekdays?: number[];
};

export type Task = {
  id: string;
  userId: string;
  text: string;
  note: string;
  completedAt: string | null;
  deletedAt: string | null;
  schedule: TaskSchedule;
  repeat: RepeatRule | null;
  skippedDates: string[];
  tags: string[];
  epicId: string | null;
  frog: boolean;
  rank: string;
  ownerId: string;
  delegateId: string | null;
  encryption: { algorithm: string; keyId: string } | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type MutableTaskField =
  | "text"
  | "note"
  | "schedule"
  | "repeat"
  | "epicId"
  | "frog"
  | "delegateId"
  | "encryption";

export type SemanticCommand =
  | "create"
  | "update"
  | "complete"
  | "reopen"
  | "skip"
  | "delete"
  | "restore"
  | "reorder"
  | "tags";

export type TaskOperation = {
  operationId: string;
  taskId: string;
  deviceId: string;
  baseRevision: number;
  command: SemanticCommand;
  changedFields: Partial<Pick<Task, MutableTaskField>>;
  tagChanges?: { add: string[]; remove: string[] };
  skipDate?: string;
  ordering?: { beforeId: string | null; afterId: string | null };
  clientTime: string;
};

export type Conflict = {
  id: string;
  taskId: string;
  operationId: string;
  fields: string[];
  mine: TaskOperation["changedFields"];
  canonical: Task;
  createdAt: string;
};

export type SyncEvent = {
  cursor: number;
  task: Task;
  conflict: Conflict | null;
  operationId: string;
};

export type CommandResult = {
  task: Task;
  conflict: Conflict | null;
  cursor: number;
  duplicate: boolean;
};

export const taskFieldGroups: Record<MutableTaskField, string> = {
  text: "text",
  note: "note",
  schedule: "schedule",
  repeat: "repeat",
  epicId: "epicId",
  frog: "frog",
  delegateId: "delegateId",
  encryption: "encryption"
};

export function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase("en-US");
}

export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

export function rankBetween(before: string | null, after: string | null): string {
  const low = before === null ? 0 : Number(before);
  const high = after === null ? low + 2048 : Number(after);
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
    throw new Error("Invalid ordering neighbors");
  }
  return String((low + high) / 2);
}

export function touchedFields(operation: TaskOperation): string[] {
  const semantic: Partial<Record<SemanticCommand, string[]>> = {
    complete: ["completedAt"],
    reopen: ["completedAt"],
    skip: ["skippedDates"],
    delete: ["deletedAt"],
    restore: ["deletedAt"],
    reorder: ["rank"],
    tags: ["tags"]
  };
  return [
    ...Object.keys(operation.changedFields),
    ...(semantic[operation.command] ?? [])
  ];
}

export function canApplyToTombstone(operation: TaskOperation): boolean {
  return operation.command === "restore" || operation.command === "delete";
}

export const canonicalRules = [
  "Capture an actionable task as soon as it appears. Do not trust yourself to remember it later.",
  "Write every task as an explicit action. If it takes less than two minutes, do it now and record it as complete.",
  "Give work a real date or leave it in Planning until you can. Trust the system to bring it back at the right time.",
  "Plan the month ahead, then review and redistribute the day each morning.",
  "After planning, focus on the first current task. Complete tasks linearly instead of jumping around the list.",
  "Frogs are tasks you are likely to avoid. Put them first and handle them while your attention is fresh.",
  "Skip sparingly, and never skip a frog. Reschedule deliberately when reality changes.",
  "Break work that is too broad into smaller explicit actions.",
  "Keep useful links, context, phone numbers, and notes with the task so the action is easy to start.",
  "Use Planning order to express what comes next. Frogs remain ahead of ordinary work.",
  "Use tags and epics to connect related work without hiding it in forgotten folders.",
  "Create repetitions consciously, and skip a missed occurrence explicitly so history stays truthful."
] as const;
