import { computed, signal } from "@preact/signals";
import { compareRanks, rankBetween, stripRemovedEpicData, type CommandResult, type Conflict, type SyncEvent, type Task, type TaskOperation } from "@todorant/domain";
import {
  activateLocalUser,
  cursor,
  deactivateLocalUser,
  identity,
  localDb,
  setCursor,
  type PendingOperation
} from "./db.js";

export const tasks = signal<Task[]>([]);
export const conflicts = signal<Conflict[]>([]);
export const connection = signal<"offline" | "syncing" | "live">("offline");
export const pendingCount = signal(0);
export const syncErrors = signal<PendingOperation[]>([]);
export const orderedTasks = computed(() => [...tasks.value].sort((a, b) => compareRanks(a.rank, b.rank)));

let csrf = "";
let activeUser = "";
let websocket: WebSocket | undefined;
let reconnectTimer: number | undefined;
let retryFlushTimer: number | undefined;
let flushing = false;
let eventChain = Promise.resolve();

const serializeReconciliation = <T>(callback: () => Promise<T>): Promise<T> => {
  const result = eventChain.then(callback);
  eventChain = result.then(() => undefined, () => undefined);
  return result;
};

const saveTask = async (task: Task, force = false) => {
  const db = await localDb();
  const transaction = db.transaction("tasks", "readwrite");
  const current = await transaction.store.get(task.id);
  if (!force && current && current.revision >= task.revision) {
    await transaction.done;
    return;
  }
  await transaction.store.put(task);
  await transaction.done;
  const currentSignal = tasks.value.find((item) => item.id === task.id);
  if (!force && currentSignal && currentSignal.revision > task.revision) return;
  tasks.value = [...tasks.value.filter((current) => current.id !== task.id), task];
};

const saveConflict = async (conflict: Conflict | null) => {
  if (!conflict) return;
  const db = await localDb();
  await db.put("conflicts", conflict);
  conflicts.value = [...conflicts.value.filter((current) => current.id !== conflict.id), conflict];
};

export const canAccessTask = (task: Task, userId: string): boolean =>
  task.userId === userId || task.delegateId === userId;

const removeTask = async (taskId: string) => {
  const db = await localDb();
  await db.delete("tasks", taskId);
  tasks.value = tasks.value.filter((task) => task.id !== taskId);
};

const revokeLocalTaskAccess = async (taskId: string) => {
  const db = await localDb();
  const [operations, storedConflicts] = await Promise.all([
    db.getAll("operations"),
    db.getAll("conflicts")
  ]);
  await Promise.all([
    db.delete("tasks", taskId),
    ...operations.filter((operation) => operation.taskId === taskId).map((operation) => db.delete("operations", operation.operationId)),
    ...storedConflicts.filter((conflict) => conflict.taskId === taskId).map((conflict) => db.delete("conflicts", conflict.id))
  ]);
  tasks.value = tasks.value.filter((task) => task.id !== taskId);
  conflicts.value = conflicts.value.filter((conflict) => conflict.taskId !== taskId);
  syncErrors.value = syncErrors.value.filter((operation) => operation.taskId !== taskId);
  pendingCount.value = await db.count("operations");
};

export const applyEvent = async (event: SyncEvent, userId = activeUser) => {
  const db = await localDb();
  if (!canAccessTask(event.task, userId)) {
    await revokeLocalTaskAccess(event.task.id);
    await setCursor(event.cursor);
    return;
  }
  if (event.cursor <= await cursor()) return;
  const operations = await db.getAll("operations");
  const pendingForTask = operations.some((operation) => operation.taskId === event.task.id);
  await saveConflict(event.conflict);
  if (pendingForTask) {
    await setCursor(event.cursor);
    return;
  }
  await saveTask(event.task, true);
  await setCursor(event.cursor);
};

export class RequestFailure extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = "RequestFailure";
  }
}

const request = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (csrf && init.method && !["GET", "HEAD"].includes(init.method)) headers.set("x-csrf-token", csrf);
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch {
    throw new RequestFailure("Connection lost. This change will retry automatically.", true);
  }
  if (!response.ok) {
    throw new RequestFailure(
      (await response.json().catch(() => null))?.error ?? "Request failed",
      response.status >= 500,
      response.status
    );
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
};

export const isRetryableFailure = (error: unknown): boolean =>
  error instanceof RequestFailure && error.retryable;

export const optimisticTask = (current: Task | undefined, operation: TaskOperation): Task => {
  const now = new Date().toISOString();
  const tailRank = tasks.value.reduce<string | null>(
    (maximum, item) => maximum === null || compareRanks(item.rank, maximum) > 0 ? item.rank : maximum,
    null
  );
  let task: Task = current
    ? { ...stripRemovedEpicData(current), ...operation.changedFields, updatedAt: now }
    : {
        id: operation.taskId,
        userId: activeUser,
        text: String(operation.changedFields.text ?? ""),
        note: String(operation.changedFields.note ?? ""),
        completedAt: null,
        deletedAt: null,
        schedule: operation.changedFields.schedule ?? { month: null, date: null, time: null, timezone: null },
        repetitive: operation.changedFields.repetitive ?? false,
        frogFails: 0,
        skippedDates: [],
        tags: [],
        frog: operation.changedFields.frog ?? false,
        rank: rankBetween(tailRank, null),
        ownerId: activeUser,
        delegateId: operation.changedFields.delegateId ?? null,
        delegation: operation.changedFields.delegation ?? null,
        legacyDelegation: operation.changedFields.legacyDelegation ?? null,
        encryption: operation.changedFields.encryption ?? null,
        parentId: operation.changedFields.parentId ?? null,
        revision: 1,
        createdAt: now,
        updatedAt: now
      };
  if (current) task = { ...task, revision: current.revision + 1 };
  if (operation.command === "complete") task = { ...task, completedAt: now };
  if (operation.command === "reopen") task = { ...task, completedAt: null };
  if (operation.command === "delete") task = { ...task, deletedAt: now };
  if (operation.command === "restore") task = { ...task, deletedAt: null };
  if (operation.command === "skip" && operation.skipDate) {
    task = { ...task, skippedDates: [...new Set([...task.skippedDates, operation.skipDate])] };
  }
  if (operation.command === "tags") {
    const remove = new Set(operation.tagChanges?.remove ?? []);
    task = {
      ...task,
      tags: [...new Set([...task.tags.filter((tag) => !remove.has(tag)), ...(operation.tagChanges?.add ?? [])])].sort()
    };
  }
  if (operation.command === "reorder" && operation.ordering) {
    const lower = operation.ordering.afterId
      ? tasks.value.find((item) => item.id === operation.ordering?.afterId)?.rank ?? null
      : null;
    const upper = operation.ordering.beforeId
      ? tasks.value.find((item) => item.id === operation.ordering?.beforeId)?.rank ?? null
      : null;
    task = { ...task, rank: rankBetween(lower, upper) };
  }
  if (operation.command === "delegate-assign" && operation.delegationUserId) {
    task = {
      ...task,
      delegateId: null,
      delegation: { delegateId: operation.delegationUserId, status: "pending", updatedAt: now }
    };
  }
  if (operation.command === "delegate-revoke" && task.delegation) {
    task = {
      ...task,
      delegateId: null,
      delegation: { ...task.delegation, status: "revoked", updatedAt: now }
    };
  }
  return task;
};

const replayPendingForTask = async (canonical: Task): Promise<void> => {
  const db = await localDb();
  const operations = (await db.getAllFromIndex("operations", "queuedAt"))
    .filter((operation) => operation.taskId === canonical.id);
  let replayed = canonical;
  for (const operation of operations) {
    replayed = optimisticTask(replayed, operation);
  }
  await saveTask(replayed, true);
};

const replayAllPending = async (): Promise<void> => {
  const db = await localDb();
  const operations = await db.getAllFromIndex("operations", "queuedAt");
  const byTask = new Map<string, PendingOperation[]>();
  for (const operation of operations) {
    const list = byTask.get(operation.taskId) ?? [];
    list.push(operation);
    byTask.set(operation.taskId, list);
  }
  for (const [taskId, taskOperations] of byTask) {
    let replayed = await db.get("tasks", taskId);
    for (const operation of taskOperations) {
      replayed = optimisticTask(replayed, operation);
    }
    if (replayed) await saveTask(replayed, true);
  }
};

export async function queueCommand(
  taskId: string,
  command: TaskOperation["command"],
  changedFields: TaskOperation["changedFields"] = {},
  extras: Pick<TaskOperation, "ordering" | "skipDate" | "tagChanges" | "delegationUserId"> = {}
): Promise<void> {
  await serializeReconciliation(async () => {
    // Identity lookup and the IndexedDB read/write transaction are deliberately
    // inside the same serialized section. Every rapid edit therefore derives
    // from the latest persisted optimistic revision, rather than a stale signal.
    const deviceId = await identity();
    const db = await localDb();
    const transaction = db.transaction(["tasks", "operations"], "readwrite");
    const taskStore = transaction.objectStore("tasks");
    const operationStore = transaction.objectStore("operations");
    const current = await taskStore.get(taskId);
    const timestamp = new Date().toISOString();
    const latestQueued = await operationStore.index("queuedAt").openCursor(undefined, "prev");
    const queuedAt = latestQueued && latestQueued.value.queuedAt >= timestamp
      ? new Date(Date.parse(latestQueued.value.queuedAt) + 1).toISOString()
      : timestamp;
    const operation: PendingOperation = {
      operationId: crypto.randomUUID(),
      taskId,
      deviceId,
      baseRevision: current?.revision ?? 0,
      command,
      changedFields,
      clientTime: timestamp,
      queuedAt,
      status: "queued",
      ...extras
    };
    const task = optimisticTask(current, operation);
    await Promise.all([
      taskStore.put(task),
      operationStore.put(operation)
    ]);
    await transaction.done;
    tasks.value = [...tasks.value.filter((item) => item.id !== task.id), task];
    pendingCount.value = await db.count("operations");
  });
  void flush();
}

export async function flush(): Promise<void> {
  if (flushing || !activeUser || !navigator.onLine) return;
  flushing = true;
  let continueFlushing = false;
  connection.value = "syncing";
  try {
    const db = await localDb();
    const operations = await db.getAllFromIndex("operations", "queuedAt");
    for (const operation of operations) {
      if (operation.status === "failed") break;
      try {
        const result = await request<CommandResult>("/api/commands", {
          method: "POST",
          body: JSON.stringify(operation)
        });
        await serializeReconciliation(async () => {
          await db.delete("operations", operation.operationId);
          await saveTask(result.task, true);
          await replayPendingForTask(result.task);
          await saveConflict(result.conflict);
          await setCursor(result.cursor);
        });
      } catch (caught) {
        if (!isRetryableFailure(caught)) {
          operation.status = "failed";
          operation.error = caught instanceof Error ? caught.message : "Command rejected";
          await db.put("operations", operation);
        } else {
          connection.value = "offline";
          if (retryFlushTimer) window.clearTimeout(retryFlushTimer);
          retryFlushTimer = window.setTimeout(() => void flush(), 1500);
        }
        break;
      }
    }
    pendingCount.value = (await db.count("operations"));
    syncErrors.value = (await db.getAll("operations")).filter((operation) => operation.status === "failed");
    if (pendingCount.value === 0) await serializeReconciliation(() => pull());
    continueFlushing = pendingCount.value > 0 && syncErrors.value.length === 0 && connection.value !== "offline";
    connection.value = websocket?.readyState === WebSocket.OPEN ? "live" : "offline";
  } catch {
    connection.value = "offline";
  } finally {
    flushing = false;
    if (continueFlushing) queueMicrotask(() => void flush());
  }
}

type Snapshot = { tasks: Task[]; events: SyncEvent[]; cursor: number };

export async function applySnapshot(snapshot: Snapshot, force = false): Promise<void> {
  const db = await localDb();
  const accessibleIds = new Set(snapshot.tasks.map((task) => task.id));
  const operations = await db.getAll("operations");
  for (const localTask of await db.getAll("tasks")) {
    if (accessibleIds.has(localTask.id)) continue;
    const pending = operations.filter((operation) => operation.taskId === localTask.id);
    if (pending.some((operation) => operation.command === "create")) continue;
    if (pending.length) await revokeLocalTaskAccess(localTask.id);
    else await removeTask(localTask.id);
  }
  for (const task of snapshot.tasks) await saveTask(task, force);
  for (const event of snapshot.events) await applyEvent(event);
  await setCursor(snapshot.cursor);
  if (force) await replayAllPending();
}

export async function pull(force = false): Promise<void> {
  const localCursor = await cursor();
  const snapshot = await request<Snapshot>(`/api/snapshot?cursor=${localCursor}`);
  await applySnapshot(snapshot, force);
}

export async function applyRemoteCommandResult(result: CommandResult): Promise<void> {
  await serializeReconciliation(async () => {
    await saveTask(result.task, true);
    await saveConflict(result.conflict);
    await setCursor(result.cursor);
  });
}

const connect = async () => {
  if (!activeUser) return;
  await pull().catch(() => undefined);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  websocket = new WebSocket(`${protocol}//${location.host}/ws?cursor=${await cursor()}`);
  websocket.addEventListener("open", () => {
    connection.value = "live";
    void flush();
  });
  websocket.addEventListener("message", (message) => {
    const payload = JSON.parse(String(message.data)) as { type: string; event?: SyncEvent };
    if (payload.type === "event" && payload.event) {
      void serializeReconciliation(() => applyEvent(payload.event as SyncEvent));
    }
  });
  websocket.addEventListener("close", () => {
    connection.value = "offline";
    if (activeUser) reconnectTimer = window.setTimeout(() => void connect(), 1500);
  });
};

export async function startSync(userId: string, csrfToken: string): Promise<void> {
  await activateLocalUser(userId);
  activeUser = userId;
  csrf = csrfToken;
  const db = await localDb();
  tasks.value = await db.getAll("tasks");
  conflicts.value = await db.getAll("conflicts");
  pendingCount.value = await db.count("operations");
  syncErrors.value = (await db.getAll("operations")).filter((operation) => operation.status === "failed");
  window.addEventListener("online", flush);
  await connect();
}

export async function stopSync(): Promise<void> {
  activeUser = "";
  csrf = "";
  window.removeEventListener("online", flush);
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  if (retryFlushTimer) window.clearTimeout(retryFlushTimer);
  websocket?.close();
  websocket = undefined;
  tasks.value = [];
  conflicts.value = [];
  syncErrors.value = [];
  pendingCount.value = 0;
  connection.value = "offline";
  await deactivateLocalUser();
}

export async function resolveConflict(conflict: Conflict, restoreMine: boolean): Promise<void> {
  if (restoreMine) {
    const extras: Pick<TaskOperation, "ordering" | "skipDate" | "tagChanges" | "delegationUserId"> = {};
    if (conflict.mine.ordering) extras.ordering = conflict.mine.ordering;
    if (conflict.mine.skipDate) extras.skipDate = conflict.mine.skipDate;
    if (conflict.mine.tagChanges) extras.tagChanges = conflict.mine.tagChanges;
    if (conflict.mine.delegationUserId) extras.delegationUserId = conflict.mine.delegationUserId;
    await queueCommand(conflict.taskId, conflict.mine.command, conflict.mine.changedFields, extras);
  }
  const db = await localDb();
  await db.delete("conflicts", conflict.id);
  conflicts.value = conflicts.value.filter((item) => item.id !== conflict.id);
}

export async function retryFailedOperation(operationId: string): Promise<void> {
  const db = await localDb();
  const operation = await db.get("operations", operationId);
  if (!operation) return;
  operation.status = "queued";
  delete operation.error;
  await db.put("operations", operation);
  syncErrors.value = syncErrors.value.filter((item) => item.operationId !== operationId);
  void flush();
}

export async function discardFailedOperation(operationId: string): Promise<void> {
  const db = await localDb();
  await serializeReconciliation(async () => {
    const failed = await db.get("operations", operationId);
    if (!failed) return;
    await db.delete("operations", operationId);
    const later = (await db.getAllFromIndex("operations", "queuedAt")).filter(
      (operation) => operation.taskId === failed.taskId && operation.queuedAt > failed.queuedAt
    );
    for (const operation of later) {
      operation.baseRevision = Math.max(0, operation.baseRevision - 1);
      await db.put("operations", operation);
    }
    await pull(true);
  });
  syncErrors.value = syncErrors.value.filter((item) => item.operationId !== operationId);
  pendingCount.value = await db.count("operations");
  void flush();
}

export const api = { request, setCsrf: (token: string) => (csrf = token) };
