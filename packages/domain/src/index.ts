import { generateKeyBetween } from "fractional-indexing";

export type TaskSchedule = {
  month: string | null;
  date: string | null;
  time: string | null;
  timezone: string | null;
};

export type DelegationStatus = "pending" | "accepted" | "rejected" | "revoked";

export type TaskDelegation = {
  delegateId: string;
  status: DelegationStatus;
  updatedAt: string;
};

export type DelegationInvite = {
  taskId: string;
  revision: number;
  ownerEmail: string;
  assignedAt: string;
};

export type Task = {
  id: string;
  userId: string;
  text: string;
  note: string;
  completedAt: string | null;
  deletedAt: string | null;
  schedule: TaskSchedule;
  repetitive: boolean;
  frogFails: number;
  skippedDates: string[];
  tags: string[];
  epicId: string | null;
  frog: boolean;
  rank: string;
  ownerId: string;
  delegateId: string | null;
  delegation: TaskDelegation | null;
  legacyDelegation: { userId: string; delegatorId: string | null; accepted: boolean | null } | null;
  encryption: { algorithm: string; keyId: string } | null;
  parentId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type MutableTaskField =
  | "text"
  | "note"
  | "schedule"
  | "repetitive"
  | "epicId"
  | "frog"
  | "frogFails"
  | "skippedDates"
  | "delegateId"
  | "delegation"
  | "legacyDelegation"
  | "encryption"
  | "parentId";

export type SemanticCommand =
  | "create"
  | "update"
  | "complete"
  | "reopen"
  | "skip"
  | "delete"
  | "restore"
  | "reorder"
  | "tags"
  | "delegate-assign"
  | "delegate-accept"
  | "delegate-reject"
  | "delegate-revoke";

export type TaskOperation = {
  operationId: string;
  taskId: string;
  deviceId: string;
  baseRevision: number;
  command: SemanticCommand;
  changedFields: Partial<Pick<Task, MutableTaskField>>;
  tagChanges?: { add: string[]; remove: string[] };
  delegationUserId?: string;
  skipDate?: string;
  ordering?: { beforeId: string | null; afterId: string | null };
  clientTime: string;
};

export type Conflict = {
  id: string;
  taskId: string;
  operationId: string;
  fields: string[];
  mine: TaskOperation;
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
  repetitive: "repetitive",
  epicId: "epicId",
  frog: "frog",
  frogFails: "frogFails",
  skippedDates: "skippedDates",
  delegateId: "delegateId",
  delegation: "delegation",
  legacyDelegation: "legacyDelegation",
  encryption: "encryption",
  parentId: "parentId"
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
  try {
    return generateKeyBetween(before, after);
  } catch {
    throw new Error("Invalid ordering neighbors");
  }
}

export const compareRanks = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export function touchedFields(operation: TaskOperation): string[] {
  const semantic: Partial<Record<SemanticCommand, string[]>> = {
    complete: ["completedAt"],
    reopen: ["completedAt"],
    skip: ["skippedDates"],
    delete: ["deletedAt"],
    restore: ["deletedAt"],
    reorder: ["rank"],
    tags: ["tags"],
    "delegate-assign": ["delegateId", "delegation"],
    "delegate-accept": ["delegateId", "delegation"],
    "delegate-reject": ["delegateId", "delegation"],
    "delegate-revoke": ["delegateId", "delegation"]
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
  "As soon as you get an actionable task (receive an email, phonecall, text, or if you see anything of interest that has to be put on your todo list) — create a todo for it right away. Do not wait, you will forget about it if you do not take it down.",
  "Todos should always be actionable and as explicit as possible. If a task takes less than 2 minutes, then do it right away and record it as completed.",
  "You either add a specific date or select a month while creating a todo. You cannot pick current month without selecting a specific date. This is done to relax your mind. If you trust the system and put everything that needs to be done on the correct date — you will encounter it at the right time. Huge amount of willpower is wasted on being constantly stressed about that other thing that you need to deal with but are not quite sure what it was. Learn to trust and relax.",
  "First thing you do each month is planning ahead. You take all the tasks assigned to the current month and you sort them in the correct dates. It allows you to filter out outdated tasks and keep your mind in peace, knowing exactly what you need to do this month.",
  "First thing you do in the morning is planning your day. Have a glance at your Planning section. Can you handle everything? Distribute tasks that cannot be dealt with today. Redistribute any tasks left undone from the previous days.",
  "Unless it is an emergency, do not look at the planning section after you have finished planning. It will be way better psychologically if you only focus on one task, so keep your eyes on the Current section. Trust the system, it remembers everything. Do your job and relax your mind.",
  "Current section contains only one task that you need to focus on — nothing else. You can have more than one task a day, but you are not allowed to jump between tasks. Deal with every task linearly, one by one.",
  "Frogs are special types of tasks you generally do not want to deal with. Todorant ensures that you handle frogs first thing every day, while your willpower reserve is large enough to handle even the most outrageous tasks.",
  "You are allowed to skip the current task, but try to do so as rarely as possible. You cannot skip a frog. If you failed to complete a task and had to redistribute it twice, it becomes a frog.",
  "If the current task is too high level, break it down to a list of subtasks. As soon as you break it down, the task is marked as completed.",
  "Add as much relevant information about the todo as possible: links, notes, documents, phone numbers, or any information you might need to complete the task.",
  "Use Planning order to change what comes next. To assign a task to a specific week, assign it to Monday and redistribute it during Monday planning.",
  "Todorant does not have and will never have repeating tasks. Add every occurrence manually; your brain will thank you for conscious tasks.",
  "Todorant does not use project folders. Instead, use #hashtags.",
  "Frogs will always appear on the top of the list.",
  "Todorant does not notify you about tasks with an exact time. Use a calendar integration when you need time-based notifications."
] as const;
