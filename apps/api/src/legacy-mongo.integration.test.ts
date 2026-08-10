import { MongoClient, ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryDataStore } from "./memory-store.js";
import { MigrationService, MongoLegacyReader } from "./migration.js";

const adminUrl = process.env.TEST_LEGACY_MONGO_ADMIN_URL;
const readerUrl = process.env.TEST_LEGACY_MONGO_URL;
const suite = adminUrl && readerUrl ? describe : describe.skip;

suite("read-only legacy Mongo fixture", () => {
  const databaseName = "todorant_legacy_fixture";
  const legacyUserId = new ObjectId("507f1f77bcf86cd799439011");
  let admin: MongoClient;

  beforeAll(async () => {
    admin = new MongoClient(adminUrl as string);
    await admin.connect();
    const database = admin.db(databaseName);
    await database.dropDatabase();
    await database.command({
      createUser: "legacy_reader",
      pwd: "fixture-read-only-password",
      roles: [{ role: "read", db: databaseName }]
    });
    await database.collection("users").insertOne({
      _id: legacyUserId,
      email: "person@example.com",
      token: "fixture-legacy-access-token",
      name: "Legacy Person",
      timezone: -420,
      delegates: [new ObjectId("507f191e810c19729de860ea")],
      delegateInviteToken: "must-not-migrate",
      settings: {
        firstDayOfWeek: 1,
        newTodosGoFirst: true,
        googleCalendarCredentials: { access_token: "must-not-migrate" }
      }
    });
    await database.collection("users").insertOne({
      _id: new ObjectId("507f191e810c19729de860ea"),
      email: "friend@example.com",
      name: "Legacy Friend"
    });
    await database.collection("todos").insertMany([
      {
        _id: new ObjectId("507f1f77bcf86cd799439012"),
        user: legacyUserId,
        text: "Actual legacy task #launch",
        completed: true,
        frog: true,
        repetitive: true,
        frogFails: 2,
        skipped: true,
        order: 1,
        deleted: false,
        encrypted: false,
        monthAndYear: "2026-08",
        date: "09",
        time: "10:30"
      },
      {
        _id: new ObjectId("507f1f77bcf86cd799439013"),
        user: legacyUserId,
        delegator: new ObjectId("507f191e810c19729de860ea"),
        delegateAccepted: true,
        text: "U2FsdGVkX1+legacyciphertext",
        completed: false,
        frog: false,
        repetitive: false,
        frogFails: 0,
        skipped: false,
        order: 2,
        deleted: false,
        encrypted: true,
        monthAndYear: "08-2026"
      },
      {
        _id: new ObjectId("507f1f77bcf86cd799439014"),
        user: new ObjectId("507f191e810c19729de860ea"),
        delegator: legacyUserId,
        delegateAccepted: false,
        text: "Pending legacy delegation",
        completed: false,
        frog: false,
        repetitive: false,
        frogFails: 0,
        skipped: false,
        order: 3,
        deleted: false,
        encrypted: false,
        monthAndYear: "09-2026"
      }
    ]);
    await database.collection("tags").insertMany([
      { _id: new ObjectId(), user: legacyUserId, tag: "work", epic: false },
      { _id: new ObjectId(), user: legacyUserId, tag: "launch", epic: true, epicGoal: 4, epicOrder: 1 }
    ]);
    await database.collection("reports").insertOne({
      _id: new ObjectId(),
      user: legacyUserId,
      uuid: "fixture-report",
      meta: { completedTodosMap: { "2026-08-09": 1 }, completedFrogsMap: { "2026-08-09": 1 } }
    });
  });

  afterAll(async () => {
    await admin?.close();
  });

  it("proves ownership, exact legacy mapping, secret stripping, zero writes, and safe retry", async () => {
    const reader = new MongoLegacyReader(readerUrl as string, databaseName);
    await expect(reader.verifyOwnership("person@example.com", "wrong-token-value")).rejects.toThrow();
    const verified = await reader.verifyOwnership("person@example.com", "fixture-legacy-access-token");
    expect(verified).toBe(String(legacyUserId));

    const before = await admin.db(databaseName).collection("todos").countDocuments();
    const source = await reader.read(verified);
    const after = await admin.db(databaseName).collection("todos").countDocuments();
    expect(after).toBe(before);
    expect(source.tasks).toHaveLength(3);
    expect(source.tags).toHaveLength(2);
    expect(source.tags.find((tag) => tag.tag === "launch")).toEqual(expect.objectContaining({ tag: "launch" }));
    expect(source.tags.some((tag) => Object.keys(tag).some((key) => key.toLocaleLowerCase().startsWith("epic")))).toBe(false);
    expect(source.users[0]).not.toHaveProperty("token");
    expect(source.users[0]).not.toHaveProperty("delegateInviteToken");
    expect(source.settings[0]).not.toHaveProperty("googleCalendarCredentials");

    const readOnlyClient = new MongoClient(readerUrl as string);
    await readOnlyClient.connect();
    await expect(readOnlyClient.db(databaseName).collection("todos").insertOne({ text: "forbidden" })).rejects.toThrow();
    await readOnlyClient.close();

    const store = new MemoryDataStore();
    const user = await store.createUser("person@example.com", "hash");
    const friend = await store.createUser("friend@example.com", "hash");
    const migration = new MigrationService(store, reader);
    const first = await migration.run(await store.createImportRun(user.id, null), verified);
    const retry = await migration.run(await store.createImportRun(user.id, first.id), verified);
    expect(first).toMatchObject({ status: "complete", counts: { tasks: 3, tags: 2 } });
    expect(Object.values(retry.counts).every((count) => count === 0)).toBe(true);
    const imported = [...store.tasks.values()];
    expect(imported.find((item) => item.text === "Actual legacy task #launch")).toMatchObject({
      userId: user.id,
      text: "Actual legacy task #launch",
      repetitive: true,
      frogFails: 2,
      schedule: { month: "2026-08", date: "2026-08-09", time: "10:30" }
    });
    expect(imported.find((item) => item.text === "U2FsdGVkX1+legacyciphertext")).toMatchObject({
      userId: friend.id,
      ownerId: friend.id,
      text: "U2FsdGVkX1+legacyciphertext",
      encryption: { algorithm: "legacy-aes" },
      delegateId: user.id,
      delegation: { delegateId: user.id, status: "accepted" }
    });
    expect(imported.find((item) => item.text === "Pending legacy delegation")).toMatchObject({
      userId: user.id,
      ownerId: user.id,
      delegateId: null,
      delegation: { delegateId: friend.id, status: "pending" },
      legacyDelegation: { accepted: false }
    });
    expect(await admin.db(databaseName).collection("todos").countDocuments()).toBe(before);
  });
});
