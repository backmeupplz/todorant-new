import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { compareRanks, type TaskOperation } from "@todorant/domain";
import {
  activateLocalUser,
  cursor,
  deactivateLocalUser,
  localDb,
  setCursor,
  type PendingOperation
} from "./db.js";
import { canAccessTask, optimisticTask, tasks } from "./sync.js";

const operation = (
  operationId: string,
  baseRevision: number,
  changedFields: TaskOperation["changedFields"],
  command: TaskOperation["command"] = "update"
): PendingOperation => ({
  operationId,
  taskId: "00000000-0000-4000-8000-000000000201",
  deviceId: "indexeddb-device",
  baseRevision,
  command,
  changedFields,
  clientTime: "2026-08-09T00:00:00.000Z",
  queuedAt: `2026-08-09T00:00:0${baseRevision}.000Z`,
  status: "queued"
});

afterEach(async () => {
  await deactivateLocalUser();
  tasks.value = [];
});

describe("per-user IndexedDB replica", () => {
  it("preserves an offline outbox across logout without exposing it to another account", async () => {
    await activateLocalUser("00000000-0000-4000-8000-000000000211");
    const db = await localDb();
    const first = operation("00000000-0000-4000-8000-000000000212", 0, { text: "Offline" }, "create");
    const created = optimisticTask(undefined, first);
    const second = operation("00000000-0000-4000-8000-000000000213", created.revision, { note: "Still offline" });
    const edited = optimisticTask(created, second);
    await db.put("operations", first);
    await db.put("operations", second);
    await db.put("tasks", edited);
    await setCursor(5);
    await setCursor(3);
    expect(await cursor()).toBe(5);
    await deactivateLocalUser();

    await activateLocalUser("00000000-0000-4000-8000-000000000214");
    expect(await (await localDb()).count("operations")).toBe(0);
    await deactivateLocalUser();

    await activateLocalUser("00000000-0000-4000-8000-000000000211");
    const restored = await localDb();
    expect(await restored.count("operations")).toBe(2);
    expect(await restored.get("tasks", edited.id)).toMatchObject({ revision: 2, note: "Still offline" });
  });

  it("optimistically ranks reorder commands between neighboring task ids", () => {
    const first = optimisticTask(undefined, operation("00000000-0000-4000-8000-000000000215", 0, { text: "First" }, "create"));
    tasks.value = [first];
    const secondOperation = { ...operation("00000000-0000-4000-8000-000000000216", 0, { text: "Second" }, "create"), taskId: "00000000-0000-4000-8000-000000000202" };
    const second = optimisticTask(undefined, secondOperation);
    tasks.value = [first, second];
    const moved = optimisticTask(second, {
      ...operation("00000000-0000-4000-8000-000000000217", second.revision, {}, "reorder"),
      taskId: second.id,
      ordering: { afterId: null, beforeId: first.id }
    });
    expect(compareRanks(moved.rank, first.rank)).toBeLessThan(0);
    expect(moved.revision).toBe(second.revision + 1);
  });

  it("removes access when an owner revokes delegation", () => {
    const ownerId = "00000000-0000-4000-8000-000000000218";
    const delegateId = "00000000-0000-4000-8000-000000000219";
    const task = {
      ...optimisticTask(undefined, operation("00000000-0000-4000-8000-000000000220", 0, { text: "Shared" }, "create")),
      userId: ownerId,
      ownerId,
      delegateId
    };
    expect(canAccessTask(task, delegateId)).toBe(true);
    expect(canAccessTask({ ...task, delegateId: null }, delegateId)).toBe(false);
    expect(canAccessTask({ ...task, delegateId: null }, ownerId)).toBe(true);
  });
});
