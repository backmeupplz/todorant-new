import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Conflict, Task, TaskOperation } from "@todorant/domain";

type PendingOperation = TaskOperation & { queuedAt: string };

interface TodorantDatabase extends DBSchema {
  tasks: { key: string; value: Task };
  operations: { key: string; value: PendingOperation; indexes: { queuedAt: string } };
  conflicts: { key: string; value: Conflict };
  meta: { key: string; value: string | number };
}

let database: Promise<IDBPDatabase<TodorantDatabase>> | undefined;

export const localDb = () => {
  database ??= openDB<TodorantDatabase>("todorant-vnext", 1, {
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

export async function identity(): Promise<string> {
  const db = await localDb();
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
  await (await localDb()).put("meta", value, "cursor");
}

export async function localUser(): Promise<string | null> {
  const value = await (await localDb()).get("meta", "userId");
  return typeof value === "string" ? value : null;
}

export async function setLocalUser(value: string): Promise<void> {
  await (await localDb()).put("meta", value, "userId");
}

export async function resetLocalData(): Promise<void> {
  const db = await localDb();
  const transaction = db.transaction(["tasks", "operations", "conflicts", "meta"], "readwrite");
  await Promise.all([
    transaction.objectStore("tasks").clear(),
    transaction.objectStore("operations").clear(),
    transaction.objectStore("conflicts").clear(),
    transaction.objectStore("meta").delete("cursor"),
    transaction.objectStore("meta").delete("userId")
  ]);
  await transaction.done;
}

export type { PendingOperation };
