import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const migrationUrl = process.env.MIGRATION_DATABASE_URL;
if (!migrationUrl) throw new Error("MIGRATION_DATABASE_URL is required");

const pool = new Pool({ connectionString: migrationUrl, max: 1 });

try {
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url))
  });
  process.stdout.write("Database migrations are current.\n");
} finally {
  await pool.end();
}
