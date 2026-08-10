import type { TaskOperation } from "@todorant/domain";
import { describe, expect, it } from "vitest";
import { MemoryDataStore } from "./memory-store.js";

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
    expect(conflicted.conflict?.mine).toEqual({ note: "Client B" });
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
    expect(Number(tagged.task.rank)).toBeGreaterThan(0);
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
    expect(Number(second.task.rank)).toBeGreaterThan(Number(first.task.rank));
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
});
