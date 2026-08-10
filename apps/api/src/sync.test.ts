import { compareRanks, type TaskOperation } from "@todorant/domain";
import { describe, expect, it } from "vitest";
import { MemoryDataStore } from "./memory-store.js";
import { applyOperation } from "./sync.js";

const op = (
  operationId: string,
  baseRevision: number,
  changedFields: TaskOperation["changedFields"],
  command: TaskOperation["command"] = "update"
): TaskOperation => ({
  operationId,
  taskId: "00000000-0000-4000-8000-000000000001",
  deviceId: "device-a",
  baseRevision,
  command,
  changedFields,
  clientTime: new Date().toISOString()
});

describe("multi-client synchronization", () => {
  it("deduplicates retried offline operations", async () => {
    const store = new MemoryDataStore();
    const create = op("00000000-0000-4000-8000-000000000010", 0, { text: "Write tests" }, "create");
    const first = await store.applyCommand("user-1", create);
    const retried = await store.applyCommand("user-1", create);
    expect(first.task.revision).toBe(1);
    expect(retried.task.revision).toBe(1);
    expect(retried.duplicate).toBe(true);
  });

  it("merges non-overlapping changes and preserves same-field conflicts", async () => {
    const store = new MemoryDataStore();
    await store.applyCommand("user-1", op("00000000-0000-4000-8000-000000000011", 0, { text: "Original" }, "create"));
    await store.applyCommand("user-1", op("00000000-0000-4000-8000-000000000012", 1, { note: "Client A" }));
    const merged = await store.applyCommand("user-1", op("00000000-0000-4000-8000-000000000013", 1, { frog: true }));
    expect(merged.task.note).toBe("Client A");
    expect(merged.task.frog).toBe(true);
    expect(merged.conflict).toBeNull();

    const conflicted = await store.applyCommand("user-1", op("00000000-0000-4000-8000-000000000014", 1, { note: "Client B" }));
    expect(conflicted.task.note).toBe("Client A");
    expect(conflicted.conflict?.mine.changedFields).toEqual({ note: "Client B" });
  });

  it("replays a durable cursor after reconnect", async () => {
    const store = new MemoryDataStore();
    await store.applyCommand("user-1", op("00000000-0000-4000-8000-000000000015", 0, { text: "One" }, "create"));
    await store.applyCommand("user-1", op("00000000-0000-4000-8000-000000000016", 1, { text: "Two" }));
    const replay = await store.snapshot("user-1", 1);
    expect(replay.events.map((event) => event.cursor)).toEqual([2]);
  });

  it("keeps tombstones until an explicit restore command", async () => {
    const store = new MemoryDataStore();
    await store.applyCommand("user-1", op("00000000-0000-4000-8000-000000000017", 0, { text: "Gone" }, "create"));
    await store.applyCommand("user-1", op("00000000-0000-4000-8000-000000000018", 1, {}, "delete"));
    const staleEdit = await store.applyCommand("user-1", op("00000000-0000-4000-8000-000000000019", 1, { text: "Offline" }));
    expect(staleEdit.task.deletedAt).not.toBeNull();
    expect(staleEdit.conflict).not.toBeNull();
    const restored = await store.applyCommand("user-1", op("00000000-0000-4000-8000-000000000020", 3, {}, "restore"));
    expect(restored.task.deletedAt).toBeNull();
  });

  it("orders by neighboring task ranks and merges tag sets", async () => {
    const store = new MemoryDataStore();
    const first = await store.applyCommand("user-1", op("00000000-0000-4000-8000-000000000021", 0, { text: "Ranked" }, "create"));
    const tagged = await store.applyCommand("user-1", {
      ...op("00000000-0000-4000-8000-000000000022", first.task.revision, {}, "tags"),
      tagChanges: { add: ["work", "focus"], remove: [] }
    });
    expect(tagged.task.tags).toEqual(["focus", "work"]);
    expect(tagged.task.rank.length).toBeGreaterThan(0);
  });

  it("merges concurrent stale tag deltas without a whole-field conflict", async () => {
    const store = new MemoryDataStore();
    await store.applyCommand("user-1", op("00000000-0000-4000-8000-000000000033", 0, { text: "Tagged" }, "create"));
    const clientA = await store.applyCommand("user-1", {
      ...op("00000000-0000-4000-8000-000000000034", 1, {}, "tags"),
      deviceId: "device-a",
      tagChanges: { add: ["alpha"], remove: [] }
    });
    const clientB = await store.applyCommand("user-1", {
      ...op("00000000-0000-4000-8000-000000000035", 1, {}, "tags"),
      deviceId: "device-b",
      tagChanges: { add: ["beta"], remove: [] }
    });
    expect(clientA.conflict).toBeNull();
    expect(clientB.conflict).toBeNull();
    expect(clientB.task.tags).toEqual(["alpha", "beta"]);

    const staleRemove = await store.applyCommand("user-1", {
      ...op("00000000-0000-4000-8000-000000000036", 2, {}, "tags"),
      deviceId: "device-a",
      tagChanges: { add: [], remove: ["alpha"] }
    });
    expect(staleRemove.conflict).toBeNull();
    expect(staleRemove.task.tags).toEqual(["beta"]);
  });

  it("assigns distinct stable tail ranks to new tasks", async () => {
    const store = new MemoryDataStore();
    const first = await store.applyCommand(
      "user-1",
      op("00000000-0000-4000-8000-000000000025", 0, { text: "First" }, "create")
    );
    const second = await store.applyCommand("user-1", {
      ...op("00000000-0000-4000-8000-000000000026", 0, { text: "Second" }, "create"),
      taskId: "00000000-0000-4000-8000-000000000002"
    });
    expect(compareRanks(second.task.rank, first.task.rank)).toBeGreaterThan(0);
  });

  it("preserves stale semantic intent instead of overwriting a newer semantic state", async () => {
    const store = new MemoryDataStore();
    await store.applyCommand("user-1", op("00000000-0000-4000-8000-000000000027", 0, { text: "Semantic" }, "create"));
    await store.applyCommand("user-1", op("00000000-0000-4000-8000-000000000028", 1, {}, "complete"));
    const staleReopen = await store.applyCommand(
      "user-1",
      op("00000000-0000-4000-8000-000000000029", 1, {}, "reopen")
    );
    expect(staleReopen.task.completedAt).not.toBeNull();
    expect(staleReopen.conflict?.fields).toEqual(["completedAt"]);
    expect(staleReopen.conflict?.mine.command).toBe("reopen");
    expect((await store.history("user-1", staleReopen.task.id)).at(-1)?.conflict).toEqual(staleReopen.conflict);
  });

  it("keeps frogs at the front of deliberate work by rejecting skips", async () => {
    const store = new MemoryDataStore();
    await store.applyCommand(
      "user-1",
      op("00000000-0000-4000-8000-000000000023", 0, { text: "Hard thing", frog: true }, "create")
    );
    await expect(
      store.applyCommand("user-1", {
        ...op("00000000-0000-4000-8000-000000000024", 1, {}, "skip"),
        skipDate: "2026-08-09"
      })
    ).rejects.toThrow("Frog tasks cannot be skipped");
  });

  it("keeps invitations private through assign, reject, accept, and revoke", async () => {
    const store = new MemoryDataStore();
    const owner = await store.createUser("owner@example.com", "hash");
    const delegate = await store.createUser("delegate@example.com", "hash");
    const created = await store.applyCommand(owner.id, op(
      "00000000-0000-4000-8000-000000000040",
      0,
      { text: "Private until accepted" },
      "create"
    ));
    const lifecycle = (
      operationId: string,
      baseRevision: number,
      command: TaskOperation["command"],
      delegationUserId?: string
    ): TaskOperation => ({
      ...op(operationId, baseRevision, {}, command),
      ...(delegationUserId ? { delegationUserId } : {})
    });

    const pending = await store.applyCommand(owner.id, lifecycle(
      "00000000-0000-4000-8000-000000000041",
      created.task.revision,
      "delegate-assign",
      delegate.id
    ));
    expect(pending.task).toMatchObject({ delegateId: null, delegation: { status: "pending" } });
    expect((await store.snapshot(delegate.id, 0)).tasks).toHaveLength(0);
    expect(await store.history(delegate.id, created.task.id)).toEqual([]);
    expect(await store.delegationInvites(delegate.id)).toMatchObject([{ ownerEmail: "owner@example.com" }]);

    const rejected = await store.applyCommand(delegate.id, lifecycle(
      "00000000-0000-4000-8000-000000000042",
      pending.task.revision,
      "delegate-reject"
    ));
    expect(rejected.task).toMatchObject({ delegateId: null, delegation: { status: "rejected" } });
    expect(await store.delegationInvites(delegate.id)).toEqual([]);

    const reassigned = await store.applyCommand(owner.id, lifecycle(
      "00000000-0000-4000-8000-000000000043",
      rejected.task.revision,
      "delegate-assign",
      delegate.id
    ));
    const accepted = await store.applyCommand(delegate.id, lifecycle(
      "00000000-0000-4000-8000-000000000044",
      reassigned.task.revision,
      "delegate-accept"
    ));
    expect(accepted.task).toMatchObject({ delegateId: delegate.id, delegation: { status: "accepted" } });
    expect((await store.snapshot(delegate.id, 0)).tasks).toHaveLength(1);

    const delegateEdit = op(
      "00000000-0000-4000-8000-000000000046",
      accepted.task.revision,
      { note: "Delegate edit" }
    );
    const edited = await store.applyCommand(delegate.id, delegateEdit);
    await expect(store.applyCommand(delegate.id, delegateEdit)).resolves.toMatchObject({
      duplicate: true,
      task: { note: "Delegate edit", revision: edited.task.revision }
    });

    const revoked = await store.applyCommand(owner.id, lifecycle(
      "00000000-0000-4000-8000-000000000045",
      edited.task.revision,
      "delegate-revoke"
    ));
    expect(revoked.task).toMatchObject({ delegateId: null, delegation: { status: "revoked" } });
    expect((await store.snapshot(delegate.id, 0)).tasks).toHaveLength(0);
    expect(await store.history(delegate.id, created.task.id)).toEqual([]);
    await expect(store.applyCommand(delegate.id, delegateEdit)).rejects.toThrow("Task not found");

    const delegateOwned = await store.applyCommand(delegate.id, {
      ...op("00000000-0000-4000-8000-000000000049", 0, { text: "Delegate-owned" }, "create"),
      taskId: "00000000-0000-4000-8000-000000000002"
    });
    await expect(store.applyCommand(delegate.id, {
      ...delegateEdit,
      taskId: delegateOwned.task.id
    })).rejects.toThrow("Task not found");

    const pendingAgain = await store.applyCommand(owner.id, lifecycle(
      "00000000-0000-4000-8000-000000000047",
      revoked.task.revision,
      "delegate-assign",
      delegate.id
    ));
    await expect(store.applyCommand(delegate.id, delegateEdit)).rejects.toThrow("Task not found");
    await expect(store.applyCommand(delegate.id, {
      ...delegateEdit,
      command: "delegate-accept",
      changedFields: {}
    })).rejects.toThrow("Task not found");
    const rejectedAgain = await store.applyCommand(delegate.id, lifecycle(
      "00000000-0000-4000-8000-000000000048",
      pendingAgain.task.revision,
      "delegate-reject"
    ));
    expect(rejectedAgain.task.delegation?.status).toBe("rejected");
    await expect(store.applyCommand(delegate.id, delegateEdit)).rejects.toThrow("Task not found");
  });

  it("turns a task into a frog after two overdue redistributions", async () => {
    const store = new MemoryDataStore();
    const created = await store.applyCommand(
      "user-1",
      op("00000000-0000-4000-8000-000000000030", 0, {
        text: "Avoided",
        schedule: { month: "2026-01", date: "2026-01-01", time: null, timezone: "UTC" }
      }, "create")
    );
    const first = applyOperation({
      current: created.task,
      operation: op("00000000-0000-4000-8000-000000000031", 1, {
        schedule: { month: "2026-02", date: "2026-02-01", time: null, timezone: "UTC" }
      }),
      fieldsChangedAfterBase: [],
      beforeRank: null,
      afterRank: null,
      now: "2026-01-02T09:00:00.000Z",
      userId: "user-1"
    }).task;
    const second = applyOperation({
      current: first,
      operation: op("00000000-0000-4000-8000-000000000032", 2, {
        schedule: { month: "2026-03", date: "2026-03-01", time: null, timezone: "UTC" }
      }),
      fieldsChangedAfterBase: [],
      beforeRank: null,
      afterRank: null,
      now: "2026-02-02T09:00:00.000Z",
      userId: "user-1"
    }).task;
    expect(first).toMatchObject({ frogFails: 1, frog: false });
    expect(second).toMatchObject({ frogFails: 2, frog: true });
  });
});
