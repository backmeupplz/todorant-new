import { computed, signal } from "@preact/signals";
import type { CommandResult, Conflict, SyncEvent, Task, TaskOperation } from "@todorant/domain";
import {
  cursor,
  identity,
  localDb,
  localUser,
  resetLocalData,
  setCursor,
  setLocalUser,
  type PendingOperation
} from "./db.js";

export const tasks = signal<Task[]>([]);
export const conflicts = signal<Conflict[]>([]);
export const connection = signal<"offline" | "syncing" | "live">("offline");
export const pendingCount = signal(0);
export const orderedTasks = computed(() => [...tasks.value].sort((a, b) => Number(a.rank) - Number(b.rank)));

let csrf = "";
let activeUser = "";
let websocket: WebSocket | undefined;
let reconnectTimer: number | undefined;
let flushing = false;

const saveTask = async (task: Task) => {
  const db = await localDb();
  await db.put("tasks", task);
  tasks.value = [...tasks.value.filter((current) => current.id !== task.id), task];
};

const saveConflict = async (conflict: Conflict | null) => {
  if (!conflict) return;
  const db = await localDb();
  await db.put("conflicts", conflict);
  conflicts.value = [...conflicts.value.filter((current) => current.id !== conflict.id), conflict];
};

const applyEvent = async (event: SyncEvent) => {
  await saveTask(event.task);
  await saveConflict(event.conflict);
  await setCursor(event.cursor);
};

const request = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (csrf && init.method && !["GET", "HEAD"].includes(init.method)) headers.set("x-csrf-token", csrf);
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? "Request failed");
  return (response.status === 204 ? undefined : await response.json()) as T;
};

const optimistic = (current: Task | undefined, operation: TaskOperation): Task => {
  const now = new Date().toISOString();
  let task: Task = current
    ? { ...current, ...operation.changedFields, updatedAt: now }
    : {
        id: operation.taskId,
        userId: activeUser,
        text: String(operation.changedFields.text ?? ""),
        note: String(operation.changedFields.note ?? ""),
        completedAt: null,
        deletedAt: null,
        schedule: operation.changedFields.schedule ?? { date: null, time: null, timezone: null },
        repeat: operation.changedFields.repeat ?? null,
        skippedDates: [],
        tags: [],
        epicId: operation.changedFields.epicId ?? null,
        frog: operation.changedFields.frog ?? false,
        rank: String((tasks.value.length + 1) * 1024),
        ownerId: activeUser,
        delegateId: operation.changedFields.delegateId ?? null,
        encryption: operation.changedFields.encryption ?? null,
        revision: 0,
        createdAt: now,
        updatedAt: now
      };
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
  return task;
};

export async function queueCommand(
  taskId: string,
  command: TaskOperation["command"],
  changedFields: TaskOperation["changedFields"] = {},
  extras: Pick<TaskOperation, "ordering" | "skipDate" | "tagChanges"> = {}
): Promise<void> {
  const current = tasks.value.find((task) => task.id === taskId);
  const operation: PendingOperation = {
    operationId: crypto.randomUUID(),
    taskId,
    deviceId: await identity(),
    baseRevision: current?.revision ?? 0,
    command,
    changedFields,
    clientTime: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
    ...extras
  };
  const db = await localDb();
  const transaction = db.transaction(["tasks", "operations"], "readwrite");
  const task = optimistic(current, operation);
  await Promise.all([transaction.objectStore("tasks").put(task), transaction.objectStore("operations").put(operation)]);
  await transaction.done;
  tasks.value = [...tasks.value.filter((item) => item.id !== task.id), task];
  pendingCount.value += 1;
  void flush();
}

export async function flush(): Promise<void> {
  if (flushing || !activeUser || !navigator.onLine) return;
  flushing = true;
  connection.value = "syncing";
  try {
    const db = await localDb();
    const operations = await db.getAllFromIndex("operations", "queuedAt");
    for (const operation of operations) {
      const result = await request<CommandResult>("/api/commands", {
        method: "POST",
        body: JSON.stringify(operation)
      });
      await saveTask(result.task);
      await saveConflict(result.conflict);
      await setCursor(result.cursor);
      await db.delete("operations", operation.operationId);
    }
    pendingCount.value = (await db.count("operations"));
    connection.value = websocket?.readyState === WebSocket.OPEN ? "live" : "offline";
  } catch {
    connection.value = "offline";
  } finally {
    flushing = false;
  }
}

export async function pull(): Promise<void> {
  const localCursor = await cursor();
  const snapshot = await request<{ tasks: Task[]; events: SyncEvent[]; cursor: number }>(
    `/api/snapshot?cursor=${localCursor}`
  );
  for (const task of snapshot.tasks) await saveTask(task);
  for (const event of snapshot.events) await applyEvent(event);
  await setCursor(snapshot.cursor);
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
    if (payload.type === "event" && payload.event) void applyEvent(payload.event);
  });
  websocket.addEventListener("close", () => {
    connection.value = "offline";
    if (activeUser) reconnectTimer = window.setTimeout(() => void connect(), 1500);
  });
};

export async function startSync(userId: string, csrfToken: string): Promise<void> {
  const previousUser = await localUser();
  if (previousUser && previousUser !== userId) await resetLocalData();
  await setLocalUser(userId);
  activeUser = userId;
  csrf = csrfToken;
  const db = await localDb();
  tasks.value = await db.getAll("tasks");
  conflicts.value = await db.getAll("conflicts");
  pendingCount.value = await db.count("operations");
  window.addEventListener("online", flush);
  await connect();
}

export async function stopSync(): Promise<void> {
  activeUser = "";
  csrf = "";
  window.removeEventListener("online", flush);
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  websocket?.close();
  websocket = undefined;
  tasks.value = [];
  conflicts.value = [];
  pendingCount.value = 0;
  connection.value = "offline";
  await resetLocalData();
}

export async function resolveConflict(conflict: Conflict, restoreMine: boolean): Promise<void> {
  if (restoreMine) await queueCommand(conflict.taskId, "update", conflict.mine);
  const db = await localDb();
  await db.delete("conflicts", conflict.id);
  conflicts.value = conflicts.value.filter((item) => item.id !== conflict.id);
}

export const api = { request, setCsrf: (token: string) => (csrf = token) };
