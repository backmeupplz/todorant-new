ALTER TABLE "tasks" ADD COLUMN "delegate_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
CREATE INDEX "tasks_delegate_rank_idx" ON "tasks" ("delegate_id", "rank");

ALTER TABLE "task_events" ADD COLUMN "delegate_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
CREATE INDEX "task_events_delegate_cursor_idx" ON "task_events" ("delegate_id", "cursor");
