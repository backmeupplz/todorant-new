import { describe, expect, it } from "vitest";
import { MemoryDataStore } from "./memory-store.js";
import { MigrationService, type LegacyReader } from "./migration.js";

class LegacyFixture implements LegacyReader {
  readonly calls: string[] = [];

  async verifyOwnership(email: string, token: string) {
    this.calls.push(`verify:${email}:${token}`);
    if (email !== "person@example.com" || token !== "legacy-access-token") throw new Error("invalid proof");
    return "507f1f77bcf86cd799439011";
  }

  async read(legacyUserId: string) {
    this.calls.push(`read:${legacyUserId}`);
    return {
      users: [{ _id: "507f1f77bcf86cd799439011", name: "Person", timezone: -420 }],
      settings: [{ _id: "legacy-user:settings", firstDayOfWeek: 1, newTodosGoFirst: true }],
      tasks: [
        {
          _id: "legacy-task",
          user: "legacy-user",
          text: "Imported safely #launch",
          frog: true,
          frogFails: 2,
          repetitive: true,
          skipped: true,
          completed: true,
          deleted: false,
          order: 3,
          monthAndYear: "2026-08",
          date: "01",
          time: "09:30",
          encrypted: false
        }
      ],
      tags: [{ _id: "tag", tag: "work", epic: false }],
      epics: [{ _id: "epic", tag: "launch", epic: true, epicGoal: 4 }],
      delegation: [{ _id: "legacy-user:delegation", delegates: ["friend"] }],
      history: [{ _id: "report", uuid: "safe-report", meta: { completedTodosMap: { "2026-08-01": 1 } } }]
    };
  }
}

describe("legacy migration", () => {
  it("requires ownership proof and retries an allowlisted real-schema fixture idempotently", async () => {
    const store = new MemoryDataStore();
    const user = await store.createUser("person@example.com", "hash");
    const reader = new LegacyFixture();
    await expect(reader.verifyOwnership(user.email, "wrong-token")).rejects.toThrow("invalid proof");
    const legacyUserId = await reader.verifyOwnership(user.email, "legacy-access-token");
    const migration = new MigrationService(store, reader);
    const first = await store.createImportRun(user.id, null);
    const firstResult = await migration.run(first, legacyUserId);
    const retry = await store.createImportRun(user.id, first.id);
    const retryResult = await migration.run(retry, legacyUserId);

    expect(firstResult.status).toBe("complete");
    expect(firstResult.counts).toMatchObject({ tasks: 1, tags: 1, epics: 1, delegation: 1, history: 1 });
    expect(retryResult.status).toBe("complete");
    expect(Object.values(retryResult.counts).every((count) => count === 0)).toBe(true);
    expect(reader.calls).toEqual([
      "verify:person@example.com:wrong-token",
      "verify:person@example.com:legacy-access-token",
      "read:507f1f77bcf86cd799439011",
      "read:507f1f77bcf86cd799439011"
    ]);
    const importedTask = (await store.snapshot(user.id, 0)).tasks[0];
    expect(importedTask).toMatchObject({
      text: "Imported safely #launch",
      tags: ["launch"],
      frog: true,
      frogFails: 2,
      repetitive: true,
      skippedDates: ["2026-08-01"],
      schedule: { month: "2026-08", date: "2026-08-01", time: "09:30" }
    });
    expect(importedTask?.completedAt).not.toBeNull();
    expect(importedTask?.epicId).toBeTruthy();
    expect(await store.getSettings(user.id)).toMatchObject({ firstDayOfWeek: 1, newTodosGoFirst: true });
    expect([...store.legacy.values()].some((record) => "token" in record.payload)).toBe(false);
    expect([...store.legacy.values()].some((record) => "googleCalendarCredentials" in record.payload)).toBe(false);
  });
});
