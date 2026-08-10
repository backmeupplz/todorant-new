import { describe, expect, it } from "vitest";
import { MemoryDataStore } from "./memory-store.js";
import { MigrationService, type LegacyReader } from "./migration.js";

class ReadOnlyFixture implements LegacyReader {
  readonly calls: string[] = [];

  async read(email: string) {
    this.calls.push(`read:${email}`);
    return {
      users: [{ _id: "legacy-user", email }],
      settings: [{ _id: "settings", darkMode: true }],
      tasks: [{ _id: "legacy-task", text: "Imported safely", frog: true, tags: ["legacy"], skippedDates: ["2026-08-01"], completed: true }],
      tags: [{ _id: "tag", name: "legacy" }],
      epics: [{ _id: "epic", name: "Launch" }],
      delegation: [{ _id: "delegation", delegateId: "friend" }],
      history: [{ _id: "event", action: "complete" }]
    };
  }
}

describe("legacy migration", () => {
  it("uses a read-only adapter and retries idempotently without source writes", async () => {
    const store = new MemoryDataStore();
    const user = await store.createUser("person@example.com", "hash");
    const reader = new ReadOnlyFixture();
    const migration = new MigrationService(store, reader);
    const first = await store.createImportRun(user.id, null);
    const firstResult = await migration.run(first, user.email);
    const retry = await store.createImportRun(user.id, first.id);
    const retryResult = await migration.run(retry, user.email);

    expect(firstResult.status).toBe("complete");
    expect(firstResult.counts.tasks).toBe(1);
    expect(retryResult.status).toBe("complete");
    expect(Object.values(retryResult.counts).every((count) => count === 0)).toBe(true);
    expect(reader.calls).toEqual(["read:person@example.com", "read:person@example.com"]);
    const importedTask = (await store.snapshot(user.id, 0)).tasks[0];
    expect(importedTask?.text).toBe("Imported safely");
    expect(importedTask?.tags).toEqual(["legacy"]);
    expect(importedTask?.skippedDates).toEqual(["2026-08-01"]);
    expect(importedTask?.frog).toBe(true);
    expect(importedTask?.completedAt).not.toBeNull();
    expect(await store.getSettings(user.id)).toMatchObject({ darkMode: true });
  });
});
