import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import type { CommandResult, Conflict, Task } from "@todorant/domain";
import type { ReportData } from "./store.js";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)]
);

export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    csrfToken: text("csrf_token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("sessions_user_idx").on(table.userId)]
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    delegateId: uuid("delegate_id").references(() => users.id, { onDelete: "set null" }),
    pendingDelegateId: uuid("pending_delegate_id").references(() => users.id, { onDelete: "set null" }),
    revision: integer("revision").notNull(),
    rank: text("rank").notNull(),
    deleted: boolean("deleted").notNull().default(false),
    state: jsonb("state").$type<Task>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.id] }),
    index("tasks_user_rank_idx").on(table.userId, table.rank),
    index("tasks_delegate_rank_idx").on(table.delegateId, table.rank),
    index("tasks_pending_delegate_idx").on(table.pendingDelegateId)
  ]
);

export const operations = pgTable(
  "operations",
  {
    operationId: uuid("operation_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    result: jsonb("result").$type<CommandResult>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.userId, table.operationId] })]
);

export const taskEvents = pgTable(
  "task_events",
  {
    cursor: bigint("cursor", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    delegateId: uuid("delegate_id").references(() => users.id, { onDelete: "set null" }),
    taskId: uuid("task_id").notNull(),
    revision: integer("revision").notNull(),
    operationId: uuid("operation_id").notNull(),
    changedFields: text("changed_fields").array().notNull(),
    state: jsonb("state").$type<Task>().notNull(),
    conflict: jsonb("conflict").$type<Conflict | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("task_events_user_cursor_idx").on(table.userId, table.cursor),
    index("task_events_task_revision_idx").on(table.userId, table.taskId, table.revision),
    index("task_events_delegate_cursor_idx").on(table.delegateId, table.cursor)
  ]
);

export const importRuns = pgTable(
  "import_runs",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
    errors: jsonb("errors").$type<string[]>().notNull().default([]),
    retryOf: uuid("retry_of"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => [index("import_runs_user_idx").on(table.userId, table.startedAt)]
);

export const legacyImports = pgTable(
  "legacy_imports",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    legacyId: text("legacy_id").notNull(),
    checksum: text("checksum").notNull(),
    importedId: text("imported_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.userId, table.kind, table.legacyId] })]
);

export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    data: jsonb("data").$type<ReportData>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("reports_user_created_idx").on(table.userId, table.createdAt)]
);
