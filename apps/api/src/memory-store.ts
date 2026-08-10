import { compareRanks, type CommandResult, type SyncEvent, type Task, type TaskOperation } from "@todorant/domain";
import { applyOperation, changedFieldsFor } from "./sync.js";
import type {
  DataStore,
  EventPublisher,
  ImportRun,
  LegacyRecord,
  ReportData,
  SessionRecord,
  UserRecord
} from "./store.js";

export class MemoryDataStore implements DataStore {
  readonly users = new Map<string, UserRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly tasks = new Map<string, Task>();
  readonly events: SyncEvent[] = [];
  readonly operations = new Map<string, CommandResult>();
  readonly imports = new Map<string, ImportRun>();
  readonly legacy = new Map<string, LegacyRecord>();
  readonly reports = new Map<string, { userId: string; data: ReportData }>();

  constructor(private readonly publish: EventPublisher = () => undefined) {}

  async createUser(email: string, passwordHash: string): Promise<UserRecord> {
    if ([...this.users.values()].some((user) => user.email === email)) throw new Error("EMAIL_EXISTS");
    const user = { id: crypto.randomUUID(), email, passwordHash, settings: {} };
    this.users.set(user.id, user);
    return user;
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    return [...this.users.values()].find((user) => user.email === email) ?? null;
  }

  async createSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.tokenHash, session);
  }

  async getSession(tokenHash: string): Promise<(SessionRecord & { user: UserRecord }) | null> {
    const session = this.sessions.get(tokenHash);
    if (!session || session.expiresAt <= new Date()) return null;
    const user = this.users.get(session.userId);
    return user ? { ...session, user } : null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }

  async snapshot(userId: string, afterCursor: number) {
    const tasks = [...this.tasks.values()]
      .filter((task) => task.userId === userId || task.delegateId === userId)
      .sort((a, b) => compareRanks(a.rank, b.rank));
    const accessibleTasks = new Set(tasks.map((task) => `${task.userId}:${task.id}`));
    const events = this.events.filter(
      (event) => event.cursor > afterCursor && accessibleTasks.has(`${event.task.userId}:${event.task.id}`)
    );
    return { tasks, events, cursor: this.events.at(-1)?.cursor ?? 0 };
  }

  async applyCommand(userId: string, operation: TaskOperation): Promise<CommandResult> {
    const operationKey = `${userId}:${operation.operationId}`;
    const duplicate = this.operations.get(operationKey);
    if (duplicate) return { ...duplicate, duplicate: true };

    const current = [...this.tasks.values()].find(
      (task) => task.id === operation.taskId && (task.userId === userId || task.delegateId === userId)
    ) ?? null;
    const previousDelegateId = current?.delegateId ?? null;
    const taskKey = `${current?.userId ?? userId}:${operation.taskId}`;
    if (current && operation.baseRevision > current.revision) {
      throw new Error("Base revision is ahead of the canonical task");
    }
    if (current && current.userId !== userId && operation.changedFields.delegateId !== undefined) {
      throw new Error("Only the owner can change delegation");
    }
    const laterFields = this.events
      .filter(
        (event) =>
          (event.task.userId === userId || event.task.delegateId === userId) &&
          event.task.id === operation.taskId &&
          event.task.revision > operation.baseRevision
      )
      .flatMap((event) => {
        const stored = (event as SyncEvent & { changedFields?: string[] }).changedFields;
        return stored ?? [];
      });
    const neighborRank = (id: string | null | undefined): string | null =>
      id
        ? [...this.tasks.values()].find(
            (task) => task.id === id && (task.userId === userId || task.delegateId === userId)
          )?.rank ?? null
        : null;
    const tailRank = [...this.tasks.values()]
      .filter((task) => (task.userId === userId || task.delegateId === userId) && task.id !== operation.taskId)
      .reduce<string | null>((maximum, task) =>
        maximum === null || compareRanks(task.rank, maximum) > 0 ? task.rank : maximum, null);
    const { task, conflict } = applyOperation({
      current,
      operation,
      fieldsChangedAfterBase: laterFields,
      beforeRank: operation.ordering ? neighborRank(operation.ordering.afterId) : tailRank,
      afterRank: neighborRank(operation.ordering?.beforeId),
      now: new Date().toISOString(),
      userId
    });
    this.tasks.set(taskKey, task);
    const event = {
      cursor: this.events.length + 1,
      task,
      conflict,
      operationId: operation.operationId,
      changedFields: changedFieldsFor(operation).filter((field) => !conflict?.fields.includes(field))
    } as SyncEvent & { changedFields: string[] };
    this.events.push(event);
    const result = { task, conflict, cursor: event.cursor, duplicate: false };
    this.operations.set(operationKey, result);
    this.publish(task.userId, event);
    if (task.delegateId && task.delegateId !== task.userId) this.publish(task.delegateId, event);
    if (previousDelegateId && previousDelegateId !== task.delegateId && previousDelegateId !== task.userId) {
      this.publish(previousDelegateId, event);
    }
    return result;
  }

  async history(userId: string, taskId: string): Promise<SyncEvent[]> {
    const current = [...this.tasks.values()].find(
      (task) => task.id === taskId && (task.userId === userId || task.delegateId === userId)
    );
    if (!current) return [];
    return this.events.filter(
      (event) => event.task.id === taskId && event.task.userId === current.userId
    );
  }

  async createReport(userId: string, data: ReportData): Promise<string> {
    const id = crypto.randomUUID();
    this.reports.set(id, { userId, data });
    return id;
  }

  async publicReport(id: string): Promise<ReportData | null> {
    return this.reports.get(id)?.data ?? null;
  }

  async getSettings(userId: string): Promise<Record<string, unknown>> {
    return this.users.get(userId)?.settings ?? {};
  }

  async setSettings(userId: string, settings: Record<string, unknown>) {
    const user = this.users.get(userId);
    if (!user) throw new Error("User not found");
    user.settings = { ...user.settings, ...settings };
    return user.settings;
  }

  async createImportRun(userId: string, retryOf: string | null): Promise<ImportRun> {
    const run: ImportRun = {
      id: crypto.randomUUID(),
      userId,
      status: "queued",
      counts: {},
      errors: [],
      retryOf,
      startedAt: new Date().toISOString(),
      completedAt: null
    };
    this.imports.set(run.id, run);
    return run;
  }

  async updateImportRun(run: ImportRun): Promise<void> {
    this.imports.set(run.id, { ...run });
  }

  async latestImportRun(userId: string): Promise<ImportRun | null> {
    return [...this.imports.values()].filter((run) => run.userId === userId).at(-1) ?? null;
  }

  async upsertLegacyRecord(userId: string, record: LegacyRecord): Promise<boolean> {
    const key = `${userId}:${record.kind}:${record.legacyId}`;
    const existing = this.legacy.get(key);
    if (existing?.checksum === record.checksum) return false;
    this.legacy.set(key, record);
    return true;
  }

  async exportData(userId: string): Promise<Record<string, unknown>> {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      tasks: [...this.tasks.values()].filter((task) => task.userId === userId),
      events: this.events.filter((event) => event.task.userId === userId),
      settings: await this.getSettings(userId),
      legacy: [...this.legacy.entries()]
        .filter(([key]) => key.startsWith(`${userId}:`))
        .map(([, record]) => record),
      reports: [...this.reports.entries()]
        .filter(([, report]) => report.userId === userId)
        .map(([id, report]) => ({ id, data: report.data }))
    };
  }
}
