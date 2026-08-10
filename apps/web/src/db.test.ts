import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareRanks, type TaskOperation } from "@todorant/domain";
import {
  activateLocalUser,
  cursor,
  deactivateLocalUser,
  localDb,
  setCursor,
  type PendingOperation
} from "./db.js";
import { api, applyEvent, applySnapshot, canAccessTask, conflicts, isRetryableFailure, optimisticTask, pendingCount, RequestFailure, tasks } from "./sync.js";

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
  vi.unstubAllGlobals();
  await deactivateLocalUser();
  tasks.value = [];
  conflicts.value = [];
  pendingCount.value = 0;
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

  it("purges IndexedDB state and queued edits when a revocation event arrives", async () => {
    const ownerId = "00000000-0000-4000-8000-000000000221";
    const delegateId = "00000000-0000-4000-8000-000000000222";
    await activateLocalUser(delegateId);
    const db = await localDb();
    const pending = operation("00000000-0000-4000-8000-000000000223", 1, { note: "Queued delegate edit" });
    const shared = {
      ...optimisticTask(undefined, { ...pending, command: "create", baseRevision: 0, changedFields: { text: "Shared" } }),
      userId: ownerId,
      ownerId,
      delegateId,
      revision: 1
    };
    await db.put("tasks", shared);
    await db.put("operations", pending);
    await setCursor(10);
    tasks.value = [shared];
    pendingCount.value = 1;

    await applyEvent({
      cursor: 5,
      task: { ...shared, delegateId: null, revision: 2 },
      conflict: null,
      operationId: "00000000-0000-4000-8000-000000000224"
    }, delegateId);

    expect(await db.get("tasks", shared.id)).toBeUndefined();
    expect(await db.count("operations")).toBe(0);
    expect(tasks.value).toEqual([]);
    expect(pendingCount.value).toBe(0);
    expect(await cursor()).toBe(10);
  });

  it("treats an authoritative reconnect snapshot as revocation without discarding offline creates", async () => {
    const ownerId = "00000000-0000-4000-8000-000000000225";
    const delegateId = "00000000-0000-4000-8000-000000000226";
    await activateLocalUser(delegateId);
    const db = await localDb();
    const edit = operation("00000000-0000-4000-8000-000000000227", 1, { note: "Offline delegate edit" });
    const shared = {
      ...optimisticTask(undefined, { ...edit, command: "create", baseRevision: 0, changedFields: { text: "Shared offline" } }),
      userId: ownerId,
      ownerId,
      delegateId,
      revision: 1
    };
    const create = {
      ...operation("00000000-0000-4000-8000-000000000228", 0, { text: "My offline create" }, "create"),
      taskId: "00000000-0000-4000-8000-000000000229"
    };
    const created = optimisticTask(undefined, create);
    await Promise.all([
      db.put("tasks", shared),
      db.put("tasks", created),
      db.put("operations", edit),
      db.put("operations", create)
    ]);
    tasks.value = [shared, created];
    pendingCount.value = 2;

    await applySnapshot({ tasks: [], events: [], cursor: 0 });

    expect(await db.get("tasks", shared.id)).toBeUndefined();
    expect(await db.get("operations", edit.operationId)).toBeUndefined();
    expect(await db.get("tasks", created.id)).toBeDefined();
    expect(await db.get("operations", create.operationId)).toBeDefined();
    expect(tasks.value.map((task) => task.id)).toEqual([created.id]);
    expect(pendingCount.value).toBe(1);
  });

  it("keeps transport and server outages retryable but surfaces deterministic rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("offline")));
    const offline = await api.request("/api/commands", { method: "POST", body: "{}" }).catch((error) => error);
    expect(offline).toBeInstanceOf(RequestFailure);
    expect(isRetryableFailure(offline)).toBe(true);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "Temporary outage" }), {
      status: 503,
      headers: { "content-type": "application/json" }
    })));
    const outage = await api.request("/api/commands", { method: "POST", body: "{}" }).catch((error) => error);
    expect(isRetryableFailure(outage)).toBe(true);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "Revision rejected" }), {
      status: 409,
      headers: { "content-type": "application/json" }
    })));
    const rejected = await api.request("/api/commands", { method: "POST", body: "{}" }).catch((error) => error);
    expect(rejected).toMatchObject({ message: "Revision rejected", retryable: false, status: 409 });
  });
});
