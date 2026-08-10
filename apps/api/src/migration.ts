import { createHash } from "node:crypto";
import { MongoClient, ObjectId, type Document } from "mongodb";
import { normalizeEmail, type TaskOperation, type TaskSchedule } from "@todorant/domain";
import type { DataStore, ImportRun, LegacyRecord } from "./store.js";

const kinds = ["users", "settings", "tasks", "tags", "epics", "delegation", "history"] as const;
type LegacyKind = (typeof kinds)[number];
type LegacyDataset = Record<LegacyKind, Record<string, unknown>[]>;

export interface LegacyReader {
  verifyOwnership(email: string, legacyToken: string): Promise<string>;
  read(legacyUserId: string): Promise<LegacyDataset>;
}

const emptyRecords = (): LegacyDataset => ({
  users: [],
  settings: [],
  tasks: [],
  tags: [],
  epics: [],
  delegation: [],
  history: []
});

const plain = (document: Document): Record<string, unknown> =>
  JSON.parse(JSON.stringify(document)) as Record<string, unknown>;

const allowlist = (source: Record<string, unknown>, fields: readonly string[]) =>
  Object.fromEntries(fields.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]));

const userFields = ["_id", "email", "name", "timezone", "telegramZen", "telegramLanguage", "createdAt", "updatedAt"] as const;
const settingFields = [
  "removeCompletedFromCalendar",
  "showTodayOnAddTodo",
  "firstDayOfWeek",
  "startTimeOfDay",
  "newTodosGoFirst",
  "preserveOrderByTime",
  "duplicateTagInBreakdown",
  "showMoreByDefault",
  "language",
  "updatedAt"
] as const;
const taskFields = [
  "_id",
  "clientId",
  "user",
  "delegator",
  "delegateAccepted",
  "text",
  "completed",
  "frog",
  "repetitive",
  "frogFails",
  "skipped",
  "order",
  "deleted",
  "encrypted",
  "monthAndYear",
  "date",
  "time",
  "createdAt",
  "updatedAt"
] as const;
const tagFields = [
  "_id",
  "clientId",
  "tag",
  "color",
  "deleted",
  "epic",
  "epicCompleted",
  "epicGoal",
  "epicOrder",
  "numberOfUses",
  "createdAt",
  "updatedAt"
] as const;

const allowedReadActions = new Set([
  "changeStream",
  "collStats",
  "dbHash",
  "dbStats",
  "find",
  "killCursors",
  "listCollections",
  "listDatabases",
  "listIndexes",
  "listSearchIndexes",
  "planCacheRead"
]);

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

  async verifyOwnership(email: string, legacyToken: string): Promise<string> {
    return this.withReadOnlyClient(async (client) => {
      const user = await client.db(this.database).collection("users").findOne(
        { email, token: legacyToken },
        { projection: { _id: 1 } }
      );
      if (!user) throw new Error("Legacy ownership proof did not match");
      return String(user._id);
    });
  }

  async read(legacyUserId: string): Promise<LegacyDataset> {
    return this.withReadOnlyClient(async (client) => {
      const database = client.db(this.database);
      if (!/^[0-9a-f]{24}$/iu.test(legacyUserId)) throw new Error("Invalid verified legacy account id");
      const id = new ObjectId(legacyUserId);
      const legacyUser = await database.collection("users").findOne({ _id: id });
      if (!legacyUser) throw new Error("Verified legacy account no longer exists");

      const [todos, tags, reports] = await Promise.all([
        database
          .collection("todos")
          .find({ $or: [{ user: id }, { delegator: id }] })
          .sort({ order: 1, _id: 1 })
          .toArray(),
        database.collection("tags").find({ user: id }).sort({ epicOrder: 1, _id: 1 }).toArray(),
        database.collection("reports").find({ user: id }).sort({ _id: 1 }).toArray()
      ]);

      const relatedIds = [...new Set(todos.flatMap((todo) => [todo.user, todo.delegator])
        .filter((value): value is ObjectId => value instanceof ObjectId)
        .map(String))];
      const relatedUsers = relatedIds.length
        ? await database.collection("users").find({ _id: { $in: relatedIds.map((value) => new ObjectId(value)) } }).toArray()
        : [];

      const sourceUser = plain(legacyUser);
      const records = emptyRecords();
      records.users = relatedUsers.map((user) => allowlist(plain(user), userFields));
      if (!records.users.some((user) => String(user._id) === legacyUserId)) {
        records.users.unshift(allowlist(sourceUser, userFields));
      }
      records.settings = [
        {
          _id: `${legacyUserId}:settings`,
          ...allowlist(
            sourceUser.settings && typeof sourceUser.settings === "object"
              ? (sourceUser.settings as Record<string, unknown>)
              : {},
            settingFields
          )
        }
      ];
      records.tasks = todos.map((todo) => allowlist(plain(todo), taskFields));
      const safeTags = tags.map((tag) => allowlist(plain(tag), tagFields));
      records.tags = safeTags.filter((tag) => tag.epic !== true);
      records.epics = safeTags.filter((tag) => tag.epic === true);
      records.delegation = [
        {
          _id: `${legacyUserId}:delegation`,
          delegates: Array.isArray(sourceUser.delegates) ? sourceUser.delegates.map(String) : [],
          delegatesUpdatedAt: sourceUser.delegatesUpdatedAt ?? null
        }
      ];
      records.history = reports.map((report) => {
        const source = plain(report);
        return allowlist(source, ["_id", "uuid", "meta", "hash", "createdAt", "updatedAt"]);
      });
      return records;
    });
  }

  private async withReadOnlyClient<T>(callback: (client: MongoClient) => Promise<T>): Promise<T> {
    const client = new MongoClient(this.url, {
      appName: "todorant-vnext-read-only-import",
      directConnection: false,
      readConcern: { level: "majority" }
    });
    try {
      await client.connect();
      const status = await client.db(this.database).command({ connectionStatus: 1, showPrivileges: true });
      const roles = status.authInfo?.authenticatedUserRoles as Array<{ role?: string }> | undefined;
      const privileges = status.authInfo?.authenticatedUserPrivileges as Array<{ actions?: string[] }> | undefined;
      if (!roles?.length || !privileges?.length) {
        throw new Error("Legacy Mongo credentials must expose verifiable read-only privileges");
      }
      const disallowedActions = [
        ...new Set(privileges.flatMap((privilege) => privilege.actions ?? []).filter((action) => !allowedReadActions.has(action)))
      ];
      if (disallowedActions.length) {
        throw new Error(`Legacy Mongo credentials include non-read privileges: ${disallowedActions.join(", ")}`);
      }
      return await callback(client);
    } finally {
      await client.close();
    }
  }
}

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

export const stableUuid = (value: string): string => {
  const bytes = Buffer.from(digest(value).slice(0, 32), "hex");
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const legacyId = (record: Record<string, unknown>): string => String(record._id ?? record.id ?? digest(record));

const legacyMonth = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  if (/^\d{4}-\d{2}$/u.test(value)) return value;
  const old = /^(\d{2})-(\d{4})$/u.exec(value);
  return old ? `${old[2]}-${old[1]}` : null;
};

const legacySchedule = (payload: Record<string, unknown>): TaskSchedule => {
  const month = legacyMonth(payload.monthAndYear);
  const day = typeof payload.date === "string" && /^\d{2}$/u.test(payload.date) ? payload.date : null;
  return {
    month,
    date: month && day ? `${month}-${day}` : null,
    time: typeof payload.time === "string" ? payload.time : null,
    timezone: null
  };
};

const tagsFromText = (text: string): string[] =>
  [...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)].map((match) => match[1] as string);

export class MigrationService {
  constructor(
    private readonly store: DataStore,
    private readonly reader: LegacyReader
  ) {}

  async run(run: ImportRun, legacyUserId: string): Promise<ImportRun> {
    const active: ImportRun = { ...run, counts: { ...run.counts }, errors: [...run.errors], status: "running" };
    await this.store.updateImportRun(active);
    try {
      const source = await this.reader.read(legacyUserId);
      const currentLegacyUserId = legacyId(source.users.find((user) => legacyId(user) === legacyUserId) ?? { _id: legacyUserId });
      const linkedUsers = new Map<string, string>();
      for (const legacyUser of source.users) {
        if (typeof legacyUser.email !== "string") continue;
        const vNextUser = await this.store.findUserByEmail(normalizeEmail(legacyUser.email));
        if (vNextUser) linkedUsers.set(legacyId(legacyUser), vNextUser.id);
      }
      const epics = new Map(
        source.epics
          .filter((epic) => typeof epic.tag === "string")
          .map((epic) => [String(epic.tag).toLocaleLowerCase(), stableUuid(`epics:${legacyId(epic)}`)])
      );
      const epicGoals = Object.fromEntries(
        source.epics
          .filter((epic) => typeof epic.tag === "string" && typeof epic.epicGoal === "number")
          .map((epic) => [String(epic.tag), Number(epic.epicGoal)])
      );
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
          if (kind === "tasks") await this.importTask(run.userId, record, epics, currentLegacyUserId, linkedUsers);
          if (kind === "settings" && changed) {
            const settings = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "_id"));
            await this.store.setSettings(run.userId, settings);
          }
        }
        active.counts[kind] = imported;
      }
      if (Object.keys(epicGoals).length) {
        const currentSettings = await this.store.getSettings(run.userId);
        await this.store.setSettings(run.userId, {
          epicGoals: { ...(currentSettings.epicGoals as Record<string, number> | undefined), ...epicGoals }
        });
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

  private async importTask(
    userId: string,
    record: LegacyRecord,
    epics: Map<string, string>,
    currentLegacyUserId: string,
    linkedUsers: Map<string, string>
  ): Promise<void> {
    const snapshot = await this.store.snapshot(userId, 0);
    const current = snapshot.tasks.find((task) => task.id === record.importedId);
    const payload = record.payload;
    const text = String(payload.text ?? "Imported task");
    const tags = payload.encrypted === true ? [] : tagsFromText(text);
    const epicId = tags.map((tag) => epics.get(tag.toLocaleLowerCase())).find(Boolean) ?? null;
    const schedule = legacySchedule(payload);
    const legacyOwnerId = String(payload.user ?? "");
    const legacyDelegatorId = String(payload.delegator ?? "");
    const counterpartyLegacyId = legacyOwnerId === currentLegacyUserId ? legacyDelegatorId : legacyOwnerId;
    const delegateId = counterpartyLegacyId ? linkedUsers.get(counterpartyLegacyId) ?? null : null;
    const changedFields: TaskOperation["changedFields"] = {
      text,
      note: "",
      frog: Boolean(payload.frog),
      frogFails: Number.isInteger(payload.frogFails) ? Number(payload.frogFails) : 0,
      repetitive: Boolean(payload.repetitive),
      epicId,
      delegateId,
      legacyDelegation: payload.delegator
        ? {
            userId: String(payload.user),
            delegatorId: String(payload.delegator),
            accepted: typeof payload.delegateAccepted === "boolean" ? payload.delegateAccepted : null
          }
        : null,
      schedule,
      skippedDates: payload.skipped === true ? [schedule.date ?? String(payload.updatedAt ?? "legacy-skip")] : [],
      encryption: payload.encrypted === true ? { algorithm: "legacy-aes", keyId: "legacy-password" } : null,
      parentId: null
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
    if (tags.length) {
      result = await this.store.applyCommand(userId, {
        operationId: stableUuid(`${userId}:${record.legacyId}:${record.checksum}:tags`),
        taskId: record.importedId,
        deviceId: "legacy-import",
        baseRevision: result.task.revision,
        command: "tags",
        changedFields: {},
        tagChanges: { add: tags, remove: [] },
        clientTime: new Date().toISOString()
      });
    }
    if (payload.completed === true && !result.task.completedAt) {
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
    if (payload.deleted === true && !result.task.deletedAt) {
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
