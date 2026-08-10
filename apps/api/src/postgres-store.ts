import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { CommandResult, SyncEvent, TaskOperation } from "@todorant/domain";
import { applyOperation, changedFieldsFor } from "./sync.js";
import * as schema from "./schema.js";
import type {
  DataStore,
  EventPublisher,
  ImportRun,
  LegacyRecord,
  SessionRecord,
  UserRecord
} from "./store.js";

type Database = NodePgDatabase<typeof schema>;

export class PostgresDataStore implements DataStore {
  constructor(
    private readonly db: Database,
    private readonly publish: EventPublisher = () => undefined
  ) {}

  async createUser(email: string, passwordHash: string): Promise<UserRecord> {
    const [user] = await this.db
      .insert(schema.users)
      .values({ id: crypto.randomUUID(), email, passwordHash })
      .returning();
    if (!user) throw new Error("Unable to create user");
    return user;
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
    return user ?? null;
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.db.insert(schema.sessions).values(session);
  }

  async getSession(tokenHash: string): Promise<(SessionRecord & { user: UserRecord }) | null> {
    const [record] = await this.db
      .select({ session: schema.sessions, user: schema.users })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
      .where(and(eq(schema.sessions.tokenHash, tokenHash), gt(schema.sessions.expiresAt, new Date())))
      .limit(1);
    return record ? { ...record.session, user: record.user } : null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, tokenHash));
  }

  async snapshot(userId: string, afterCursor: number) {
    const [taskRows, eventRows, cursorRows] = await Promise.all([
      this.db.select().from(schema.tasks).where(eq(schema.tasks.userId, userId)).orderBy(asc(schema.tasks.rank)),
      this.db
        .select()
        .from(schema.taskEvents)
        .where(and(eq(schema.taskEvents.userId, userId), gt(schema.taskEvents.cursor, afterCursor)))
        .orderBy(asc(schema.taskEvents.cursor)),
      this.db
        .select({ cursor: schema.taskEvents.cursor })
        .from(schema.taskEvents)
        .where(eq(schema.taskEvents.userId, userId))
        .orderBy(desc(schema.taskEvents.cursor))
        .limit(1)
    ]);
    return {
      tasks: taskRows.map((row) => row.state),
      events: eventRows.map((row) => ({
        cursor: row.cursor,
        task: row.state,
        conflict: row.conflict ?? null,
        operationId: row.operationId
      })),
      cursor: cursorRows[0]?.cursor ?? 0
    };
  }

  async applyCommand(userId: string, operation: TaskOperation): Promise<CommandResult> {
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
      const [prior] = await tx
        .select()
        .from(schema.operations)
        .where(
          and(
            eq(schema.operations.userId, userId),
            eq(schema.operations.operationId, operation.operationId)
          )
        )
        .limit(1);
      if (prior) return { ...prior.result, duplicate: true };

      const [taskRow] = await tx
        .select()
        .from(schema.tasks)
        .where(and(eq(schema.tasks.userId, userId), eq(schema.tasks.id, operation.taskId)))
        .limit(1);
      const laterEvents = taskRow
        ? await tx
            .select({ fields: schema.taskEvents.changedFields })
            .from(schema.taskEvents)
            .where(
              and(
                eq(schema.taskEvents.userId, userId),
                eq(schema.taskEvents.taskId, operation.taskId),
                gt(schema.taskEvents.revision, operation.baseRevision)
              )
            )
        : [];
      const rankFor = async (id: string | null | undefined) => {
        if (!id) return null;
        const [row] = await tx
          .select({ rank: schema.tasks.rank })
          .from(schema.tasks)
          .where(and(eq(schema.tasks.userId, userId), eq(schema.tasks.id, id)))
          .limit(1);
        return row?.rank ?? null;
      };
      const [tail] = await tx
        .select({ rank: schema.tasks.rank })
        .from(schema.tasks)
        .where(eq(schema.tasks.userId, userId))
        .orderBy(desc(sql`${schema.tasks.rank}::numeric`))
        .limit(1);
      const { task, conflict } = applyOperation({
        current: taskRow?.state ?? null,
        operation,
        fieldsChangedAfterBase: laterEvents.flatMap((event) => event.fields),
        beforeRank: operation.ordering ? await rankFor(operation.ordering.afterId) : tail?.rank ?? null,
        afterRank: await rankFor(operation.ordering?.beforeId),
        now: new Date().toISOString(),
        userId
      });

      await tx
        .insert(schema.tasks)
        .values({
          id: task.id,
          userId,
          revision: task.revision,
          rank: task.rank,
          deleted: task.deletedAt !== null,
          state: task
        })
        .onConflictDoUpdate({
          target: [schema.tasks.userId, schema.tasks.id],
          set: {
            revision: task.revision,
            rank: task.rank,
            deleted: task.deletedAt !== null,
            state: task,
            updatedAt: new Date()
          }
        });
      const [event] = await tx
        .insert(schema.taskEvents)
        .values({
          userId,
          taskId: task.id,
          revision: task.revision,
          operationId: operation.operationId,
          changedFields: changedFieldsFor(operation),
          state: task,
          conflict
        })
        .returning({ cursor: schema.taskEvents.cursor });
      if (!event) throw new Error("Unable to persist task event");
      const commandResult = { task, conflict, cursor: event.cursor, duplicate: false };
      await tx.insert(schema.operations).values({
        operationId: operation.operationId,
        userId,
        result: commandResult
      });
      return commandResult;
    });
    if (!result.duplicate) {
      this.publish(userId, {
        cursor: result.cursor,
        task: result.task,
        conflict: result.conflict,
        operationId: operation.operationId
      });
    }
    return result;
  }

  async history(userId: string, taskId: string): Promise<SyncEvent[]> {
    const rows = await this.db
      .select()
      .from(schema.taskEvents)
      .where(and(eq(schema.taskEvents.userId, userId), eq(schema.taskEvents.taskId, taskId)))
      .orderBy(asc(schema.taskEvents.cursor));
    return rows.map((row) => ({
      cursor: row.cursor,
      task: row.state,
      conflict: row.conflict ?? null,
      operationId: row.operationId
    }));
  }

  async getSettings(userId: string): Promise<Record<string, unknown>> {
    const [user] = await this.db
      .select({ settings: schema.users.settings })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    return user?.settings ?? {};
  }

  async setSettings(userId: string, settings: Record<string, unknown>) {
    const current = await this.getSettings(userId);
    const merged = { ...current, ...settings };
    await this.db.update(schema.users).set({ settings: merged }).where(eq(schema.users.id, userId));
    return merged;
  }

  async createImportRun(userId: string, retryOf: string | null): Promise<ImportRun> {
    const id = crypto.randomUUID();
    const [row] = await this.db
      .insert(schema.importRuns)
      .values({ id, userId, status: "queued", retryOf })
      .returning();
    if (!row) throw new Error("Unable to create import run");
    return mapImportRun(row);
  }

  async updateImportRun(run: ImportRun): Promise<void> {
    await this.db
      .update(schema.importRuns)
      .set({
        status: run.status,
        counts: run.counts,
        errors: run.errors,
        completedAt: run.completedAt ? new Date(run.completedAt) : null
      })
      .where(eq(schema.importRuns.id, run.id));
  }

  async latestImportRun(userId: string): Promise<ImportRun | null> {
    const [row] = await this.db
      .select()
      .from(schema.importRuns)
      .where(eq(schema.importRuns.userId, userId))
      .orderBy(desc(schema.importRuns.startedAt))
      .limit(1);
    return row ? mapImportRun(row) : null;
  }

  async upsertLegacyRecord(userId: string, record: LegacyRecord): Promise<boolean> {
    const [existing] = await this.db
      .select({ checksum: schema.legacyImports.checksum })
      .from(schema.legacyImports)
      .where(
        and(
          eq(schema.legacyImports.userId, userId),
          eq(schema.legacyImports.kind, record.kind),
          eq(schema.legacyImports.legacyId, record.legacyId)
        )
      );
    if (existing?.checksum === record.checksum) return false;
    await this.db
      .insert(schema.legacyImports)
      .values({ userId, ...record })
      .onConflictDoUpdate({
        target: [schema.legacyImports.userId, schema.legacyImports.kind, schema.legacyImports.legacyId],
        set: {
          checksum: record.checksum,
          importedId: record.importedId,
          payload: record.payload,
          importedAt: new Date()
        }
      });
    return true;
  }

  async exportData(userId: string): Promise<Record<string, unknown>> {
    const [snapshot, settings, legacy, runs] = await Promise.all([
      this.snapshot(userId, 0),
      this.getSettings(userId),
      this.db.select().from(schema.legacyImports).where(eq(schema.legacyImports.userId, userId)),
      this.db.select().from(schema.importRuns).where(eq(schema.importRuns.userId, userId))
    ]);
    return { version: 1, exportedAt: new Date().toISOString(), ...snapshot, settings, legacy, importRuns: runs };
  }
}

function mapImportRun(row: typeof schema.importRuns.$inferSelect): ImportRun {
  return {
    id: row.id,
    userId: row.userId,
    status: row.status as ImportRun["status"],
    counts: row.counts,
    errors: row.errors,
    retryOf: row.retryOf,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null
  };
}

export function createPostgresStore(connectionString: string, publish?: EventPublisher) {
  const pool = new Pool({ connectionString, max: 10 });
  const db = drizzle(pool, { schema });
  return { store: new PostgresDataStore(db, publish), pool, db };
}
