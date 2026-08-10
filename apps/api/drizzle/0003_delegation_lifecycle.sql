ALTER TABLE "tasks" ADD COLUMN "pending_delegate_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
CREATE INDEX "tasks_pending_delegate_idx" ON "tasks" ("pending_delegate_id");

UPDATE "tasks"
SET "state" = jsonb_set(
  "state",
  '{delegation}',
  CASE
    WHEN "delegate_id" IS NULL THEN 'null'::jsonb
    ELSE jsonb_build_object(
      'delegateId', "delegate_id",
      'status', 'accepted',
      'updatedAt', COALESCE("state"->>'updatedAt', now()::text)
    )
  END,
  true
)
WHERE NOT ("state" ? 'delegation');
