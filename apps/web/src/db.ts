import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Conflict, Task, TaskOperation } from "@todorant/domain";

type PendingOperation = TaskOperation & {
  queuedAt: string;
  status: "queued" | "failed";
  error?: string;
};

interface TodorantDatabase extends DBSchema {
  tasks: { key: string; value: Task };
  operations: { key: string; value: PendingOperation; indexes: { queuedAt: string } };
  conflicts: { key: string; value: Conflict };
  meta: { key: string; value: string | number };
}

let database: Promise<IDBPDatabase<TodorantDatabase>> | undefined;
let activeUser = "";
let identityDatabase: Promise<IDBPDatabase<{ meta: { key: string; value: string } }>> | undefined;

export const localDb = () => {
  if (!activeUser) throw new Error("A local user must be active");
  database ??= openDB<TodorantDatabase>(`todorant-vnext-${activeUser}`, 1, {
    upgrade(db) {
      db.createObjectStore("tasks", { keyPath: "id" });
      const operations = db.createObjectStore("operations", { keyPath: "operationId" });
      operations.createIndex("queuedAt", "queuedAt");
      db.createObjectStore("conflicts", { keyPath: "id" });
      db.createObjectStore("meta");
    }
  });
  return database;
};

export async function activateLocalUser(userId: string): Promise<void> {
  if (activeUser === userId && database) return;
  if (database) (await database).close();
  activeUser = userId;
  database = undefined;
  await localDb();
}

export async function deactivateLocalUser(): Promise<void> {
  if (database) (await database).close();
  database = undefined;
  activeUser = "";
}

export async function identity(): Promise<string> {
  identityDatabase ??= openDB("todorant-vnext-device", 1, {
    upgrade(db) {
      db.createObjectStore("meta");
    }
  });
  const db = await identityDatabase;
  const existing = await db.get("meta", "deviceId");
  if (typeof existing === "string") return existing;
  const created = crypto.randomUUID();
  await db.put("meta", created, "deviceId");
  return created;
}

export async function cursor(): Promise<number> {
  const value = await (await localDb()).get("meta", "cursor");
  return typeof value === "number" ? value : 0;
}

export async function setCursor(value: number): Promise<void> {
  const db = await localDb();
  const transaction = db.transaction("meta", "readwrite");
  const current = await transaction.store.get("cursor");
  await transaction.store.put(Math.max(typeof current === "number" ? current : 0, value), "cursor");
  await transaction.done;
}

export async function resetLocalData(): Promise<void> {
  const db = await localDb();
  const transaction = db.transaction(["tasks", "operations", "conflicts", "meta"], "readwrite");
  await Promise.all([
    transaction.objectStore("tasks").clear(),
    transaction.objectStore("operations").clear(),
    transaction.objectStore("conflicts").clear(),
    transaction.objectStore("meta").delete("cursor")
  ]);
  await transaction.done;
}

export type { PendingOperation };
