UPDATE "users"
SET "settings" = "settings" - 'epicGoals'
WHERE "settings" ? 'epicGoals';

UPDATE "tasks"
SET "state" = "state" - 'epicId'
WHERE "state" ? 'epicId';

INSERT INTO "legacy_imports" (
  "user_id", "kind", "legacy_id", "checksum", "imported_id", "payload", "imported_at"
)
SELECT
  "user_id",
  'tags',
  "legacy_id",
  "checksum",
  "imported_id",
  "payload" - 'epic' - 'epicCompleted' - 'epicGoal' - 'epicOrder',
  "imported_at"
FROM "legacy_imports"
WHERE "kind" = 'epics'
ON CONFLICT ("user_id", "kind", "legacy_id") DO NOTHING;

UPDATE "legacy_imports"
SET "payload" = "payload" - 'epic' - 'epicCompleted' - 'epicGoal' - 'epicOrder'
WHERE "kind" = 'tags';

DELETE FROM "legacy_imports"
WHERE "kind" = 'epics';

UPDATE "import_runs"
SET "counts" = "counts" - 'epics'
WHERE "counts" ? 'epics';
