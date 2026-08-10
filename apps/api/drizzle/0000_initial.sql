CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid PRIMARY KEY,
  "email" text NOT NULL,
  "password_hash" text NOT NULL,
  "settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" ("email");

CREATE TABLE IF NOT EXISTS "sessions" (
  "token_hash" text PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "csrf_token" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "sessions_user_idx" ON "sessions" ("user_id");

CREATE TABLE IF NOT EXISTS "tasks" (
  "id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL CHECK ("revision" > 0),
  "rank" text NOT NULL,
  "deleted" boolean NOT NULL DEFAULT false,
  "state" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "id")
);
CREATE INDEX IF NOT EXISTS "tasks_user_rank_idx" ON "tasks" ("user_id", "rank");

CREATE TABLE IF NOT EXISTS "operations" (
  "operation_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "operation_id")
);

CREATE TABLE IF NOT EXISTS "task_events" (
  "cursor" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "task_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "operation_id" uuid NOT NULL,
  "changed_fields" text[] NOT NULL,
  "state" jsonb NOT NULL,
  "conflict" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "task_events_user_cursor_idx" ON "task_events" ("user_id", "cursor");
CREATE INDEX IF NOT EXISTS "task_events_task_revision_idx" ON "task_events" ("user_id", "task_id", "revision");

CREATE TABLE IF NOT EXISTS "import_runs" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "counts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "errors" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "retry_of" uuid,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "import_runs_user_idx" ON "import_runs" ("user_id", "started_at");

CREATE TABLE IF NOT EXISTS "legacy_imports" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "legacy_id" text NOT NULL,
  "checksum" text NOT NULL,
  "imported_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "imported_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "kind", "legacy_id")
);
