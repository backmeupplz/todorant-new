import { createHash } from "node:crypto";
import { MongoClient, type Document } from "mongodb";
import type { RepeatRule, TaskOperation, TaskSchedule } from "@todorant/domain";
import type { DataStore, ImportRun, LegacyRecord } from "./store.js";

const kinds = ["users", "settings", "tasks", "tags", "epics", "delegation", "history"] as const;
type LegacyKind = (typeof kinds)[number];

export interface LegacyReader {
  read(email: string): Promise<Record<LegacyKind, Record<string, unknown>[]>>;
}

const emptyRecords = (): Record<LegacyKind, Record<string, unknown>[]> => ({
  users: [],
  settings: [],
  tasks: [],
  tags: [],
  epics: [],
  delegation: [],
  history: []
});

export class MongoLegacyReader implements LegacyReader {
  constructor(
    private readonly url: string,
    private readonly database: string
  ) {
    const parsed = new URL(url);
    const preference = parsed.searchParams.get("readPreference")?.toLowerCase();
    if (preference !== "secondarypreferred" && preference !== "secondary") {
      throw new Error("Legacy Mongo URL must enforce a secondary read preference");
    }
    if (parsed.searchParams.get("retryWrites") !== "false") {
      throw new Error("Legacy Mongo URL must disable retryable writes");
    }
  }

  async read(email: string): Promise<Record<LegacyKind, Record<string, unknown>[]>> {
    const client = new MongoClient(this.url, {
      appName: "todorant-vnext-read-only-import",
      directConnection: false
    });
    try {
      await client.connect();
      const database = client.db(this.database);
      const legacyUsers = await database.collection("users").find({ email }).limit(1).toArray();
      const legacyUser = legacyUsers[0];
      if (!legacyUser) return emptyRecords();
      const legacyUserId = legacyUser._id;
      const records = emptyRecords();
      records.users = [plain(legacyUser)];
      for (const kind of kinds.filter((kind) => kind !== "users")) {
        records[kind] = (await database.collection(kind).find({ userId: legacyUserId }).toArray()).map(plain);
      }
      return records;
    } finally {
      await client.close();
    }
  }
}

const plain = (document: Document): Record<string, unknown> =>
  JSON.parse(JSON.stringify(document)) as Record<string, unknown>;

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const digest = (value: unknown): string => createHash("sha256").update(stable(value)).digest("hex");

const stableUuid = (value: string): string => {
  const bytes = Buffer.from(digest(value).slice(0, 32), "hex");
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const legacyId = (record: Record<string, unknown>): string => String(record._id ?? record.id ?? digest(record));

export class MigrationService {
  constructor(
    private readonly store: DataStore,
    private readonly reader: LegacyReader
  ) {}

  async run(run: ImportRun, email: string): Promise<ImportRun> {
    const active: ImportRun = { ...run, status: "running" };
    await this.store.updateImportRun(active);
    try {
      const source = await this.reader.read(email);
      for (const kind of kinds) {
        let imported = 0;
        for (const payload of source[kind]) {
          const sourceId = legacyId(payload);
          const checksum = digest(payload);
          const record: LegacyRecord = {
            kind,
            legacyId: sourceId,
            checksum,
            importedId: stableUuid(`${kind}:${sourceId}`),
            payload
          };
          const changed = await this.store.upsertLegacyRecord(run.userId, record);
          if (changed) imported += 1;
          if (kind === "tasks") await this.importTask(run.userId, record);
          if (kind === "settings" && changed) await this.store.setSettings(run.userId, payload);
        }
        active.counts[kind] = imported;
      }
      active.status = "complete";
    } catch (error) {
      active.status = "failed";
      active.errors.push(error instanceof Error ? error.message : "Unknown migration error");
    }
    active.completedAt = new Date().toISOString();
    await this.store.updateImportRun(active);
    return active;
  }

  private async importTask(userId: string, record: LegacyRecord): Promise<void> {
    const snapshot = await this.store.snapshot(userId, 0);
    const current = snapshot.tasks.find((task) => task.id === record.importedId);
    const payload = record.payload;
    const legacyFrog = Boolean(payload.frog);
    const changedFields: TaskOperation["changedFields"] = {
      text: String(payload.text ?? payload.title ?? "Imported task"),
      note: String(payload.note ?? payload.description ?? ""),
      frog: false,
      epicId: payload.epicId ? String(payload.epicId) : null,
      delegateId: payload.delegateId ? String(payload.delegateId) : null,
      repeat:
        payload.repeat && typeof payload.repeat === "object"
          ? (payload.repeat as RepeatRule)
          : null,
      schedule:
        payload.schedule && typeof payload.schedule === "object"
          ? (payload.schedule as TaskSchedule)
          : { date: null, time: null, timezone: null },
      encryption:
        payload.encryption && typeof payload.encryption === "object"
          ? (payload.encryption as { algorithm: string; keyId: string })
          : null
    };
    let result = await this.store.applyCommand(userId, {
      operationId: stableUuid(`${userId}:${record.legacyId}:${record.checksum}`),
      taskId: record.importedId,
      deviceId: "legacy-import",
      baseRevision: current?.revision ?? 0,
      command: current ? "update" : "create",
      changedFields,
      clientTime: new Date().toISOString()
    });
    const rawTags = Array.isArray(payload.tags) ? payload.tags.filter((tag): tag is string => typeof tag === "string") : [];
    if (rawTags.length) {
      result = await this.store.applyCommand(userId, {
        operationId: stableUuid(`${userId}:${record.legacyId}:${record.checksum}:tags`),
        taskId: record.importedId,
        deviceId: "legacy-import",
        baseRevision: result.task.revision,
        command: "tags",
        changedFields: {},
        tagChanges: { add: rawTags, remove: [] },
        clientTime: new Date().toISOString()
      });
    }
    const rawSkips = Array.isArray(payload.skippedDates)
      ? payload.skippedDates.filter((date): date is string => typeof date === "string")
      : [];
    for (const skipDate of rawSkips) {
      result = await this.store.applyCommand(userId, {
        operationId: stableUuid(`${userId}:${record.legacyId}:${record.checksum}:skip:${skipDate}`),
        taskId: record.importedId,
        deviceId: "legacy-import",
        baseRevision: result.task.revision,
        command: "skip",
        changedFields: {},
        skipDate,
        clientTime: new Date().toISOString()
      });
    }
    if (legacyFrog) {
      result = await this.store.applyCommand(userId, {
        operationId: stableUuid(`${userId}:${record.legacyId}:${record.checksum}:frog`),
        taskId: record.importedId,
        deviceId: "legacy-import",
        baseRevision: result.task.revision,
        command: "update",
        changedFields: { frog: true },
        clientTime: new Date().toISOString()
      });
    }
    if (payload.completedAt || payload.completed === true) {
      result = await this.store.applyCommand(userId, {
        operationId: stableUuid(`${userId}:${record.legacyId}:${record.checksum}:complete`),
        taskId: record.importedId,
        deviceId: "legacy-import",
        baseRevision: result.task.revision,
        command: "complete",
        changedFields: {},
        clientTime: new Date().toISOString()
      });
    }
    if (payload.deletedAt || payload.deleted === true) {
      await this.store.applyCommand(userId, {
        operationId: stableUuid(`${userId}:${record.legacyId}:${record.checksum}:delete`),
        taskId: record.importedId,
        deviceId: "legacy-import",
        baseRevision: result.task.revision,
        command: "delete",
        changedFields: {},
        clientTime: new Date().toISOString()
      });
    }
  }
}
