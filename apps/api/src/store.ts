import type { CommandResult, SyncEvent, Task, TaskOperation } from "@todorant/domain";

export type UserRecord = {
  id: string;
  email: string;
  passwordHash: string;
  settings: Record<string, unknown>;
};

export type SessionRecord = {
  tokenHash: string;
  userId: string;
  csrfToken: string;
  expiresAt: Date;
};

export type ImportRun = {
  id: string;
  userId: string;
  status: "queued" | "running" | "complete" | "failed";
  counts: Record<string, number>;
  errors: string[];
  retryOf: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type LegacyRecord = {
  kind: "users" | "settings" | "tasks" | "tags" | "epics" | "delegation" | "history";
  legacyId: string;
  checksum: string;
  importedId: string;
  payload: Record<string, unknown>;
};

export type ReportData = {
  completedTodosMap: Record<string, number>;
  completedFrogsMap: Record<string, number>;
  generatedAt: string;
};

export interface DataStore {
  createUser(email: string, passwordHash: string): Promise<UserRecord>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  createSession(session: SessionRecord): Promise<void>;
  getSession(tokenHash: string): Promise<(SessionRecord & { user: UserRecord }) | null>;
  deleteSession(tokenHash: string): Promise<void>;
  snapshot(userId: string, afterCursor: number): Promise<{ tasks: Task[]; events: SyncEvent[]; cursor: number }>;
  applyCommand(userId: string, operation: TaskOperation): Promise<CommandResult>;
  history(userId: string, taskId: string): Promise<SyncEvent[]>;
  createReport(userId: string, data: ReportData): Promise<string>;
  publicReport(id: string): Promise<ReportData | null>;
  getSettings(userId: string): Promise<Record<string, unknown>>;
  setSettings(userId: string, settings: Record<string, unknown>): Promise<Record<string, unknown>>;
  createImportRun(userId: string, retryOf: string | null): Promise<ImportRun>;
  updateImportRun(run: ImportRun): Promise<void>;
  latestImportRun(userId: string): Promise<ImportRun | null>;
  upsertLegacyRecord(userId: string, record: LegacyRecord): Promise<boolean>;
  exportData(userId: string): Promise<Record<string, unknown>>;
}

export type EventPublisher = (userId: string, event: SyncEvent) => void;
